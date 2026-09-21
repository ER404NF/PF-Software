// One upstream video source per device, any number of viewers.
//
// A device that can stream exposes `openStream({ onFrame, onState })` and returns
// `{ close() }` — a WDA phone reads its MJPEG feed, a phone at another site is
// relayed over the site link. The hub reference-counts viewers so the phone is
// asked for video only while somebody is looking, keeps the newest frame so a
// new viewer sees a picture immediately, and closes the upstream shortly after
// the last viewer leaves (a brief grace period stops a quick re-select from
// tearing the stream down and rebuilding it).
//
// Fan-out is synchronous and never awaits a viewer: a slow viewer is that
// viewer's problem (its onFrame decides to drop), never the phone's or the
// other viewers'.

export class StreamHub {
  constructor({ idleCloseMs = 3000, now = () => Date.now(), setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
    this.idleCloseMs = idleCloseMs;
    this.now = now;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.entries = new Map(); // deviceId -> entry
  }

  supports(device) {
    return typeof device?.openStream === "function" && device.supportsStream !== false;
  }

  // Returns { unsubscribe() } or null when the device cannot stream.
  subscribe(device, { onFrame, onState = () => {} }) {
    if (!this.supports(device)) return null;
    if (typeof onFrame !== "function") throw new TypeError("subscribe requires an onFrame callback");
    let entry = this.entries.get(device.id);
    if (entry && entry.device !== device) {
      // The phone was re-provisioned (new ports, new object): the old upstream is
      // dead. Tell its viewers so they re-request the stream, and start fresh.
      this._setState(entry, "closed", "device replaced");
      entry.subscribers.clear();
      this._closeEntry(entry);
      entry = null;
    }
    if (!entry) {
      entry = {
        device,
        deviceId: device.id,
        subscribers: new Set(),
        lastFrame: null,
        state: "connecting",
        source: null,
        idleTimer: null,
        frames: 0,
        windowStartedAt: this.now(),
        windowFrames: 0,
        fps: 0,
      };
      this.entries.set(device.id, entry);
      try {
        entry.source = device.openStream({
          onFrame: frame => this._fanout(entry, frame),
          onState: (state, detail) => this._setState(entry, state, detail),
        });
      } catch (error) {
        // Do not retain a source-less "connecting" entry. A transient port
        // or adapter failure must allow the next viewer request to make a
        // fresh open attempt instead of attaching forever to a dead entry.
        if (this.entries.get(device.id) === entry) this.entries.delete(device.id);
        try { entry.source?.close?.(); } catch { /* no usable source remains */ }
        throw error;
      }
    }
    if (entry.idleTimer) {
      this.clearTimeoutFn(entry.idleTimer);
      entry.idleTimer = null;
    }
    const subscriber = { onFrame, onState };
    entry.subscribers.add(subscriber);
    try { onState(entry.state); } catch { /* a viewer's callback must not break the hub */ }
    if (entry.lastFrame) {
      try { onFrame(entry.lastFrame); } catch { /* same */ }
    }
    return {
      unsubscribe: () => this._unsubscribe(entry, subscriber),
    };
  }

  _fanout(entry, frame) {
    entry.lastFrame = frame;
    entry.frames += 1;
    entry.windowFrames += 1;
    const elapsed = this.now() - entry.windowStartedAt;
    if (elapsed >= 2000) {
      entry.fps = Math.round((entry.windowFrames * 1000) / elapsed);
      entry.windowStartedAt = this.now();
      entry.windowFrames = 0;
    }
    if (entry.state !== "live") this._setState(entry, "live");
    for (const subscriber of entry.subscribers) {
      try { subscriber.onFrame(frame); } catch { /* isolate viewers from each other */ }
    }
  }

  _setState(entry, state, detail) {
    if (entry.state === state && detail === undefined) return;
    entry.state = state;
    for (const subscriber of entry.subscribers) {
      try { subscriber.onState(state, detail); } catch { /* isolate viewers */ }
    }
  }

  _unsubscribe(entry, subscriber) {
    if (!entry.subscribers.delete(subscriber)) return;
    if (entry.subscribers.size > 0 || this.entries.get(entry.deviceId) !== entry) return;
    entry.idleTimer = this.setTimeoutFn(() => this._closeEntry(entry), this.idleCloseMs);
    entry.idleTimer.unref?.();
  }

  _closeEntry(entry) {
    if (entry.subscribers.size > 0) return;
    if (this.entries.get(entry.deviceId) === entry) this.entries.delete(entry.deviceId);
    if (entry.idleTimer) this.clearTimeoutFn(entry.idleTimer);
    entry.idleTimer = null;
    try { entry.source?.close?.(); } catch { /* the source is going away regardless */ }
  }

  stats(deviceId) {
    const entry = this.entries.get(deviceId);
    return entry
      ? { state: entry.state, viewers: entry.subscribers.size, fps: entry.fps, frames: entry.frames }
      : { state: "idle", viewers: 0, fps: 0, frames: 0 };
  }

  // Immediately drops every upstream (server shutdown, site link lost).
  closeAll() {
    for (const entry of [...this.entries.values()]) {
      entry.subscribers.clear();
      this._closeEntry(entry);
    }
  }
}
