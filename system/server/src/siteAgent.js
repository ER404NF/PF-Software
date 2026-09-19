// Runs at a site (the Mac mini with the phones on USB). It owns the local devices
// (WDA phones reached through iproxy, or simulators) and links them to the hub:
// connects OUTBOUND over WebSocket so the site needs no open inbound port, keeps the
// hub told which phones exist and are ready, performs the actions the hub sends and
// relays each phone's live video upstream. It contains no operator logic at all:
// authentication, access rules, the exclusive lease and audit all stay on the hub.

import WebSocket from "ws";
import { StreamHub } from "./streamHub.js";
import { PROTOCOL_VERSION, RPC_METHODS, packFrame } from "./siteProtocol.js";

const VIDEO_BACKPRESSURE_BYTES = 1_000_000;

export class SiteAgent {
  constructor({
    hubUrl, siteId, token, devices,
    reconnectMinMs = 1000, reconnectMaxMs = 30_000,
    summaryIntervalMs = 5000, readinessIntervalMs = 10_000,
    WebSocketImpl = WebSocket,
    log = () => {},
  }) {
    if (!hubUrl || !siteId || !token) throw new Error("A site agent needs a hub URL, a site id and a site token.");
    this.url = `${String(hubUrl).replace(/\/+$/, "").replace(/^http/, "ws")}/agent-link`;
    this.siteId = siteId;
    this.token = token;
    this.devices = devices;
    this.reconnectMinMs = reconnectMinMs;
    this.reconnectMaxMs = reconnectMaxMs;
    this.summaryIntervalMs = summaryIntervalMs;
    this.readinessIntervalMs = readinessIntervalMs;
    this.WebSocketImpl = WebSocketImpl;
    this.log = log;
    this.streams = new StreamHub({ idleCloseMs: 2000 });
    this.subscriptions = new Map(); // hub stream id -> subscription
    this.ws = null;
    this.stopped = true;
    this.retryDelay = reconnectMinMs;
    this.retryTimer = null;
    this.summaryTimer = null;
    this.readinessTimer = null;
    this.lastSummary = "";
    this.connectedOnce = false;
  }

  start() {
    this.stopped = false;
    this._connect();
    // Deliberately NOT unref'd: while the hub is unreachable these timers are all that
    // keeps the agent process alive to retry.
    this.readinessTimer = setInterval(() => void this._refreshReadiness(), this.readinessIntervalMs);
    void this._refreshReadiness();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.summaryTimer);
    clearInterval(this.readinessTimer);
    this._dropStreams();
    this.streams.closeAll();
    try { this.ws?.close(1000, "Agent stopping"); } catch { /* already closed */ }
  }

  get connected() {
    return this.ws?.readyState === 1;
  }

  // ---- connection ---------------------------------------------------------------

  _connect() {
    if (this.stopped) return;
    const ws = new this.WebSocketImpl(this.url, {
      headers: { "x-site-id": this.siteId, authorization: `Bearer ${this.token}` },
      maxPayload: 8 * 1024 * 1024,
    });
    this.ws = ws;
    ws.on("open", () => {
      this.retryDelay = this.reconnectMinMs;
      this.connectedOnce = true;
      this.log(`linked to ${this.url}`);
      this.lastSummary = "";
      this._sendHello();
      clearInterval(this.summaryTimer);
      this.summaryTimer = setInterval(() => this._sendSummaryIfChanged(), this.summaryIntervalMs);
    });
    ws.on("message", (data, isBinary) => {
      if (isBinary) return; // the hub never sends binary
      void this._onMessage(data).catch(error => this.log(`message failed: ${error?.message}`));
    });
    ws.on("unexpected-response", (_request, response) => {
      this.log(`hub refused the link: HTTP ${response.statusCode}`);
    });
    ws.on("error", error => this.log(`link error: ${error?.message}`));
    ws.on("close", () => {
      clearInterval(this.summaryTimer);
      this._dropStreams();
      if (this.ws === ws) this.ws = null;
      if (this.stopped) return;
      this.retryTimer = setTimeout(() => this._connect(), this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 2, this.reconnectMaxMs);
    });
  }

  _send(message) {
    if (this.connected) this.ws.send(JSON.stringify(message));
  }

  // ---- what we tell the hub -------------------------------------------------------

  summaries() {
    return [...this.devices.values()].map(device => {
      const type = device.kind === "mock" ? "mock" : device.kind === "wda" ? "wda" : "discovered";
      return {
        id: device.id,
        label: device.label,
        type,
        // A simulator is always ready; a real phone is ready once its WDA answered.
        ready: type === "mock" ? true : type === "wda" ? device.readiness?.ready === true : false,
        supportsStream: device.supportsStream === true,
        discoveryState: device.discoveryState ?? null,
        discoveryStateMessage: device.discoveryStateMessage ?? null,
      };
    });
  }

  _sendHello() {
    this._send({ type: "hello", version: PROTOCOL_VERSION, devices: this.summaries() });
  }

  _sendSummaryIfChanged() {
    const devices = this.summaries();
    const serialised = JSON.stringify(devices);
    if (serialised === this.lastSummary) return;
    this.lastSummary = serialised;
    this._send({ type: "devices", devices });
  }

  async _refreshReadiness() {
    await Promise.all([...this.devices.values()]
      .filter(device => typeof device.checkReadiness === "function")
      .map(device => device.checkReadiness().catch(() => false)));
    this._sendSummaryIfChanged();
  }

  // ---- what the hub asks of us ------------------------------------------------------

  async _onMessage(data) {
    let message;
    try { message = JSON.parse(data.toString()); } catch { return; }
    if (message?.type === "rpc") await this._handleRpc(message);
    else if (message?.type === "stream_open") this._openStream(message);
    else if (message?.type === "stream_close") this._closeStream(message.streamId);
  }

  async _handleRpc({ id, deviceId, method, args }) {
    const reply = payload => this._send({ type: "rpc_result", id, ...payload });
    const device = this.devices.get(deviceId);
    if (!device) return reply({ ok: false, error: { message: "Unknown phone at this site.", code: "UNKNOWN_DEVICE" } });
    if (!RPC_METHODS.includes(method) || typeof device[method] !== "function") {
      return reply({ ok: false, error: { message: "That action is not supported.", code: "UNSUPPORTED_METHOD" } });
    }
    try {
      const value = await device[method](...(Array.isArray(args) ? args.slice(0, 6) : []));
      reply({ ok: true, value: value ?? null });
    } catch (error) {
      reply({ ok: false, error: { message: String(error?.message ?? "Action failed").slice(0, 300), code: error?.code } });
    }
  }

  _openStream({ streamId, deviceId }) {
    this._closeStream(streamId);
    const device = this.devices.get(deviceId);
    if (!Number.isSafeInteger(streamId)) return;
    if (!device || !this.streams.supports(device)) {
      this._send({ type: "stream_state", streamId, state: "closed", detail: "no live video for this phone" });
      return;
    }
    const subscription = this.streams.subscribe(device, {
      onFrame: frame => {
        if (!this.connected || this.ws.bufferedAmount > VIDEO_BACKPRESSURE_BYTES) return; // drop rather than queue
        const packet = packFrame(streamId, frame);
        if (packet) this.ws.send(packet, { binary: true });
      },
      onState: (state, detail) => this._send({ type: "stream_state", streamId, state, detail }),
    });
    if (subscription) this.subscriptions.set(streamId, subscription);
  }

  _closeStream(streamId) {
    this.subscriptions.get(streamId)?.unsubscribe();
    this.subscriptions.delete(streamId);
  }

  _dropStreams() {
    for (const streamId of [...this.subscriptions.keys()]) this._closeStream(streamId);
  }
}
