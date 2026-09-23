// Hub side of the agent link (see siteProtocol.js). Accepts one authenticated
// WebSocket per site, keeps that site's phones registered in the hub's device map
// as RemoteDevice objects, forwards phone actions to the agent and relays its live
// video. A dropped link marks the site's phones offline and is repaired by the agent
// reconnecting; video streams opened by operators are re-opened automatically then.

import { WebSocketServer } from "ws";
import { RemoteDevice, SiteOfflineError } from "./remoteDevice.js";
import {
  PROTOCOL_VERSION, RPC_METHODS, remoteDeviceId, sanitizeAdvertisedDevices, unpackFrame,
} from "./siteProtocol.js";

const PING_INTERVAL_MS = 20_000;

export class SiteLinkHub {
  constructor({
    siteStore, devices,
    onDevicesChanged = () => {},
    registerRemoteDevice = () => {},
    unregisterRemoteDevice = () => {},
    onSiteEvent = () => {},
    rpcTimeoutMs = 20_000,
    maxPayloadBytes = 8 * 1024 * 1024,
    pingIntervalMs = PING_INTERVAL_MS,
  }) {
    this.siteStore = siteStore;
    this.devices = devices;
    this.onDevicesChanged = onDevicesChanged;
    this.registerRemoteDevice = registerRemoteDevice;
    this.unregisterRemoteDevice = unregisterRemoteDevice;
    this.onSiteEvent = onSiteEvent;
    this.rpcTimeoutMs = rpcTimeoutMs;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: maxPayloadBytes });
    this.connections = new Map(); // siteId -> { ws, site, connectedAt, alive }
    this.pending = new Map(); // rpc id -> { siteId, resolve, reject, timer }
    this.wanted = new Map(); // streamId -> { siteId, localId, onFrame, onState }
    this.nextRpcId = 1;
    this.nextStreamId = 1;
    this.pingTimer = setInterval(() => this._ping(), pingIntervalMs);
    this.pingTimer.unref?.();
  }

  // ---- connection lifecycle ---------------------------------------------------

  handleUpgrade(request, socket, head) {
    const siteId = String(request.headers["x-site-id"] ?? "");
    const authorization = String(request.headers.authorization ?? "");
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    const site = this.siteStore.verifyToken(siteId, token);
    if (!site) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return false;
    }
    this.wss.handleUpgrade(request, socket, head, ws => this._accept(ws, site));
    return true;
  }

  _accept(ws, site) {
    this.connections.get(site.id)?.ws.close(4000, "Replaced by a newer connection");
    const connection = { ws, site, connectedAt: new Date().toISOString(), alive: true };
    this.connections.set(site.id, connection);
    this.siteStore.markSeen(site.id, connection.connectedAt);
    ws.on("pong", () => { connection.alive = true; });
    ws.on("error", () => ws.terminate());
    ws.on("message", (data, isBinary) => this._onMessage(connection, data, isBinary));
    ws.on("close", () => this._onClose(connection));
    this.onSiteEvent({ type: "site_connected", siteId: site.id, detail: { name: site.name } });
    // Operators already watching this site's phones (before a reconnect) get their video back.
    for (const [streamId, want] of this.wanted) if (want.siteId === site.id) this._sendStreamOpen(connection, streamId, want);
  }

  _onClose(connection) {
    const { site } = connection;
    // Calls sent on this connection can never be answered now.
    for (const [id, entry] of this.pending) {
      if (entry.connection !== connection) continue;
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.reject(new SiteOfflineError(site.name));
    }
    if (this.connections.get(site.id) !== connection) return; // replaced by a newer connection
    this.connections.delete(site.id);
    for (const want of this.wanted.values()) if (want.siteId === site.id) want.onState?.("reconnecting", "site link lost");
    for (const device of this.devices.values()) {
      if (device instanceof RemoteDevice && device.siteId === site.id) device.applyReadiness(false);
    }
    this.siteStore.markSeen(site.id);
    this.onSiteEvent({ type: "site_disconnected", siteId: site.id, detail: { name: site.name } });
    this.onDevicesChanged();
  }

  _ping() {
    for (const connection of this.connections.values()) {
      if (!connection.alive) { connection.ws.terminate(); continue; }
      connection.alive = false;
      try { connection.ws.ping(); } catch { /* the close handler cleans up */ }
    }
  }

  isOnline(siteId) {
    return this.connections.get(siteId)?.ws.readyState === 1;
  }

  siteStatus(siteId) {
    const connection = this.connections.get(siteId);
    const deviceCount = [...this.devices.values()].filter(device => device instanceof RemoteDevice && device.siteId === siteId).length;
    return { online: Boolean(connection && connection.ws.readyState === 1), connectedAt: connection?.connectedAt ?? null, deviceCount };
  }

  // ---- messages from the agent --------------------------------------------------

  _onMessage(connection, data, isBinary) {
    // A replaced connection, or a connection whose site was just deleted, may
    // still have an already-buffered message. It must never repopulate the fleet.
    if (this.connections.get(connection.site.id) !== connection || !this.siteStore.get(connection.site.id)) return;
    if (isBinary) {
      const packet = unpackFrame(data);
      const want = packet && this.wanted.get(packet.streamId);
      if (want && want.siteId === connection.site.id) {
        try { want.onFrame?.(packet.frame); } catch { /* a viewer's failure must not break the link */ }
      }
      return;
    }
    let message;
    try { message = JSON.parse(data.toString()); } catch { return; }
    if (message?.type === "hello" || message?.type === "devices") {
      if (message.type === "hello" && message.version !== PROTOCOL_VERSION) {
        connection.ws.close(4001, "Unsupported agent protocol version");
        return;
      }
      this._syncDevices(connection.site, sanitizeAdvertisedDevices(message.devices));
    } else if (message?.type === "rpc_result") {
      const entry = this.pending.get(message.id);
      if (!entry || entry.connection !== connection) return;
      clearTimeout(entry.timer);
      this.pending.delete(message.id);
      if (message.ok === true) entry.resolve(message.value ?? null);
      else {
        const error = new Error(typeof message.error?.message === "string" ? message.error.message.slice(0, 300) : "The site could not perform the action.");
        if (typeof message.error?.code === "string") error.code = message.error.code;
        entry.reject(error);
      }
    } else if (message?.type === "stream_state") {
      const want = this.wanted.get(message.streamId);
      if (want && want.siteId === connection.site.id) want.onState?.(String(message.state), message.detail ?? undefined);
    }
  }

  _syncDevices(site, advertised) {
    const liveIds = new Set();
    for (const entry of advertised) {
      const id = remoteDeviceId(site.id, entry.id);
      liveIds.add(id);
      let device = this.devices.get(id);
      if (!(device instanceof RemoteDevice)) {
        if (device) continue; // never let an agent shadow a hub-local device
        device = new RemoteDevice({ site, localId: entry.id, label: entry.label, type: entry.type, hub: this });
        this.devices.set(id, device);
        this.registerRemoteDevice(device, site);
      }
      device.siteName = site.name;
      device.timeZone = site.timeZone;
      device.label = entry.label;
      device.type = entry.type;
      device.remote.supportsStream = entry.supportsStream;
      device.discoveryState = entry.discoveryState;
      device.discoveryStateMessage = entry.discoveryStateMessage;
      device.applyReadiness(entry.ready);
    }
    for (const device of this.devices.values()) {
      if (device instanceof RemoteDevice && device.siteId === site.id && !liveIds.has(device.id)) device.applyReadiness(false);
    }
    this.onDevicesChanged();
  }

  // ---- calls to the agent -------------------------------------------------------

  call(siteId, localId, method, args = []) {
    const connection = this.connections.get(siteId);
    if (!connection || connection.ws.readyState !== 1) {
      return Promise.reject(new SiteOfflineError(this.siteStore.get(siteId)?.name ?? siteId));
    }
    if (!RPC_METHODS.includes(method)) return Promise.reject(new Error(`Unsupported remote method: ${method}`));
    const id = this.nextRpcId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error("The site did not answer in time."), { code: "SITE_TIMEOUT" }));
      }, this.rpcTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { connection, resolve, reject, timer });
      try {
        connection.ws.send(JSON.stringify({ type: "rpc", id, deviceId: localId, method, args }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  openStream(siteId, localId, { onFrame, onState = () => {} } = {}) {
    const streamId = this.nextStreamId++;
    const want = { siteId, localId, onFrame, onState };
    this.wanted.set(streamId, want);
    const connection = this.connections.get(siteId);
    if (connection?.ws.readyState === 1) this._sendStreamOpen(connection, streamId, want);
    else onState("reconnecting", "site is not connected");
    return {
      close: () => {
        if (!this.wanted.delete(streamId)) return;
        const live = this.connections.get(siteId);
        if (live?.ws.readyState === 1) live.ws.send(JSON.stringify({ type: "stream_close", streamId }));
        onState("closed");
      },
    };
  }

  _sendStreamOpen(connection, streamId, want) {
    connection.ws.send(JSON.stringify({ type: "stream_open", streamId, deviceId: want.localId }));
  }

  // ---- administration -----------------------------------------------------------

  // Forget a site: drop its link and remove its phones from the fleet.
  removeSite(siteId) {
    this.connections.get(siteId)?.ws.close(4002, "Site removed");
    for (const [id, device] of [...this.devices]) {
      if (device instanceof RemoteDevice && device.siteId === siteId) {
        this.devices.delete(id);
        this.unregisterRemoteDevice(device);
      }
    }
    for (const [streamId, want] of [...this.wanted]) {
      if (want.siteId === siteId) { want.onState?.("closed", "site removed"); this.wanted.delete(streamId); }
    }
    this.onDevicesChanged();
  }

  // A rotated token must cut the old agent off at once.
  disconnect(siteId, reason = "Token rotated") {
    this.connections.get(siteId)?.ws.close(4003, reason);
  }

  closeAll() {
    clearInterval(this.pingTimer);
    for (const connection of this.connections.values()) connection.ws.close(1001, "Hub shutting down");
    this.wss.close();
  }
}
