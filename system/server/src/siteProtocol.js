// Wire format between the hub and a site agent (the "agent link").
//
// One WebSocket per site, opened by the AGENT (outbound from the site, so a site
// needs no open inbound port), authenticated by `x-site-id` + `Authorization:
// Bearer <site token>`.
//
//   agent -> hub  JSON  { type:"hello", version, devices:[...] }      on every (re)connect
//                       { type:"devices", devices:[...] }             when a phone's state changes
//                       { type:"rpc_result", id, ok, value|error }    answers a hub call
//                       { type:"stream_state", streamId, state, detail }
//                 BIN   [kind:1][streamId:4][image bytes]            live video frames
//   hub -> agent  JSON  { type:"rpc", id, deviceId, method, args }    one phone action
//                       { type:"stream_open", streamId, deviceId }
//                       { type:"stream_close", streamId }
//
// Device ids on the hub are "<siteId>__<localId>"; the agent only ever sees its own
// local ids.

import { frameKind } from "./mjpegParser.js";
import { operationalErrorKind } from "./safeOperationalLog.js";

export const PROTOCOL_VERSION = 1;
export const REMOTE_ID_SEPARATOR = "__";

// The complete list of things a hub may ask a phone to do. The agent refuses
// anything else, so a compromised hub cannot reach arbitrary methods.
export const RPC_METHODS = Object.freeze(["tap", "swipe", "drag", "longPress", "doubleTap", "typeText", "pressHome", "render", "getUiTree"]);

export const DEVICE_TYPES = Object.freeze(["mock", "wda", "discovered"]);
export const MAX_ADVERTISED_DEVICES = 500;

const SAFE_RPC_ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
const RPC_ERROR_MESSAGES = Object.freeze({
  UNKNOWN_DEVICE: "Unknown phone at this site.",
  UNSUPPORTED_METHOD: "That action is not supported.",
  SITE_ACTION_FAILED: "The site could not perform the action.",
});
const DISCOVERY_MESSAGES = Object.freeze({
  provisioning: "Automatic device setup is in progress at this site.",
  user_action_required: "This phone needs a manual trust, Developer Mode, or WDA signing action at its site.",
  provisioning_error: "Automatic device setup failed at this site. Review that host's local diagnostics.",
  disconnected: "The phone is disconnected from its site.",
});
const STREAM_STATE_MESSAGES = Object.freeze({
  connecting: "Remote video is connecting.",
  live: null,
  reconnecting: "Remote video is reconnecting.",
  closed: "Remote video closed.",
});

function safeRpcErrorCode(value) {
  return typeof value === "string" && SAFE_RPC_ERROR_CODE_RE.test(value)
    ? value
    : "SITE_ACTION_FAILED";
}

export function publicSiteRpcError(error) {
  const code = safeRpcErrorCode(operationalErrorKind(error));
  return { code, message: RPC_ERROR_MESSAGES[code] ?? RPC_ERROR_MESSAGES.SITE_ACTION_FAILED };
}

export function siteRpcErrorFromPayload(payload) {
  const code = safeRpcErrorCode(payload?.code);
  const error = new Error(RPC_ERROR_MESSAGES[code] ?? RPC_ERROR_MESSAGES.SITE_ACTION_FAILED);
  error.code = code;
  return error;
}

export function sanitizeSiteStreamState(payload) {
  const requestedState = typeof payload?.state === "string" ? payload.state : "";
  const state = Object.hasOwn(STREAM_STATE_MESSAGES, requestedState)
    ? requestedState
    : "reconnecting";
  return { state, detail: STREAM_STATE_MESSAGES[state] };
}

export function remoteDeviceId(siteId, localId) {
  return `${siteId}${REMOTE_ID_SEPARATOR}${localId}`;
}

// A site id never contains "__" (hyphens only), so the first separator is the boundary.
export function splitRemoteDeviceId(id) {
  if (typeof id !== "string") return null;
  const at = id.indexOf(REMOTE_ID_SEPARATOR);
  if (at <= 0 || at + REMOTE_ID_SEPARATOR.length >= id.length) return null;
  return { siteId: id.slice(0, at), localId: id.slice(at + REMOTE_ID_SEPARATOR.length) };
}

export function packFrame(streamId, frame) {
  const kind = frameKind(frame);
  if (kind === 0) return null;
  const packet = Buffer.allocUnsafe(frame.length + 5);
  packet[0] = kind;
  packet.writeUInt32BE(streamId >>> 0, 1);
  Buffer.from(frame.buffer ?? frame, frame.byteOffset ?? 0, frame.length).copy(packet, 5);
  return packet;
}

export function unpackFrame(packet) {
  const bytes = Buffer.isBuffer(packet) ? packet : Buffer.from(packet);
  if (bytes.length <= 5) return null;
  const frame = bytes.subarray(5);
  if (frameKind(frame) === 0 || frameKind(frame) !== bytes[0]) return null;
  return { kind: bytes[0], streamId: bytes.readUInt32BE(1), frame };
}

// What the agent advertises about one phone. Everything is re-validated by the hub.
export function sanitizeAdvertisedDevices(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const cleaned = [];
  for (const entry of list.slice(0, MAX_ADVERTISED_DEVICES)) {
    if (!entry || typeof entry !== "object") continue;
    if (typeof entry.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(entry.id) || seen.has(entry.id)) continue;
    seen.add(entry.id);
    const text = (value, max) => (typeof value === "string" ? value.slice(0, max) : null);
    const discoveryState = text(entry.discoveryState, 40);
    cleaned.push({
      id: entry.id,
      label: text(entry.label, 100) || entry.id,
      type: DEVICE_TYPES.includes(entry.type) ? entry.type : "wda",
      ready: entry.ready === true,
      supportsStream: entry.supportsStream === true,
      discoveryState,
      discoveryStateMessage: DISCOVERY_MESSAGES[discoveryState] ?? null,
    });
  }
  return cleaned;
}
