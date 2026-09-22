// Real device, driven by a WebDriverAgent instance reachable at host:port
// (normally 127.0.0.1, reached via `iproxy <localPort>:8100` forwarding the
// phone's USB-tethered WDA server). Same tap()/render()/status contract as
// MockDevice — this is the class that swaps in once hardware exists.
//
// Endpoints used (confirmed against ../../../research/WebDriverAgent source,
// not guessed): POST /session, POST /session/:id/wda/tap {x,y},
// POST /session/:id/wda/swipe {direction,x?,y?,velocity?},
// POST /session/:id/wda/keys {value:[...strings]},
// GET /session/:id/source, GET /session/:id/screenshot,
// GET /session/:id/window/size.

// A real WDA process that's still accepting TCP connections but never
// completes a request (locked screen, crashed-but-not-exited process) would
// otherwise hang a fetch — and with it, that connection's whole action queue
// — forever. Every request below carries this as its abort signal so a dead
// device surfaces as an error within a bounded time instead of hanging.
import { MjpegParser } from "./mjpegParser.js";
import { diagnosticError } from "./errorCatalog.js";

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_READINESS_FAILURE_THRESHOLD = 3;
const MAX_IOS_LOGICAL_DIMENSION = 10000;

// Video profile requested from WDA's MJPEG server. The default favors a responsive
// local control surface while keeping the half-size frames small enough to encode
// and discard quickly. Override per host with WDA_STREAM_FPS /
// WDA_STREAM_SCALE (percent of native size) / WDA_STREAM_QUALITY (JPEG 1-100).
function envInt(name, fallback, min, max) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
}
export function defaultStreamProfile() {
  return {
    framerate: envInt("WDA_STREAM_FPS", 30, 1, 60),
    scalingFactor: envInt("WDA_STREAM_SCALE", 50, 10, 100),
    quality: envInt("WDA_STREAM_QUALITY", 45, 5, 100),
  };
}

export class WdaAuthorizationError extends Error {
  constructor() {
    super("Device authorization changed before the WDA operation could execute.");
    this.name = "WdaAuthorizationError";
    this.code = "DEVICE_ACCESS_REVOKED";
  }
}

export function assertAuthorized(authorize) {
  if (typeof authorize === "function" && authorize() !== true) throw new WdaAuthorizationError();
}

function validWindowSize(value) {
  return value && typeof value === "object"
    && Number.isFinite(value.width) && value.width > 0 && value.width <= MAX_IOS_LOGICAL_DIMENSION
    && Number.isFinite(value.height) && value.height > 0 && value.height <= MAX_IOS_LOGICAL_DIMENSION;
}

function readinessFailureWhy(error) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError") {
    return "The WDA /status endpoint did not answer before the configured timeout. This does not by itself prove the iPhone was unplugged.";
  }
  if (error?.readinessReason === "http") {
    return `The WDA /status endpoint returned HTTP ${error.httpStatus}, so the process was reachable but did not report a usable readiness response.`;
  }
  if (error?.readinessReason === "not_ready") {
    return "The WDA endpoint answered, but its response did not declare the service ready.";
  }
  return "The WDA /status request failed before a valid ready response was received. Attachment and process health must be checked separately.";
}

export class WdaDevice {
  constructor(id, label, { host = "127.0.0.1", port, mjpegPort = null, timeoutMs = DEFAULT_TIMEOUT_MS,
    readinessFailureThreshold = DEFAULT_READINESS_FAILURE_THRESHOLD } = {}) {
    this.id = id;
    this.kind = "wda";
    this.label = label;
    this.host = host;
    this.mjpegPort = Number.isSafeInteger(mjpegPort) ? mjpegPort : null;
    this.status = "offline"; // fail closed until /status confirms this WDA endpoint is ready
    this.readinessFailureThreshold = readinessFailureThreshold;
    this.readiness = {
      ready: false,
      state: "UNKNOWN",
      checkedAt: null,
      lastHealthyAt: null,
      consecutiveFailures: 0,
      lastError: null,
    };
    this.componentHealth = {
      deviceAttachment: "UNKNOWN",
      wdaProcess: "UNKNOWN",
      iproxy: "UNKNOWN",
      wdaEndpoint: "UNKNOWN",
      control: "UNAVAILABLE",
      recovery: "IDLE",
    };
    this.diagnosticEvents = [];
    this.baseUrl = `http://${host}:${port}`;
    this.timeoutMs = timeoutMs;
    this.sessionId = null;
    this.sessionPromise = null;
    this.sessionGeneration = 0;
    this.windowSize = null;
  }

  async checkReadiness() {
    const checkedAt = new Date().toISOString();
    try {
      const response = await fetch(`${this.baseUrl}/status`, { signal: AbortSignal.timeout(this.timeoutMs) });
      if (!response.ok) {
        const error = new Error(`WDA readiness failed: HTTP ${response.status}`);
        error.readinessReason = "http";
        error.httpStatus = response.status;
        throw error;
      }
      const body = await response.json();
      const ready = body?.ready === true || body?.value?.ready === true;
      if (!ready) {
        const error = new Error("WDA readiness response was not ready");
        error.readinessReason = "not_ready";
        throw error;
      }
      this.readiness = {
        ready: true,
        state: "HEALTHY",
        checkedAt,
        lastHealthyAt: checkedAt,
        consecutiveFailures: 0,
        lastError: null,
      };
      this.setComponentHealth({ wdaEndpoint: "HEALTHY", control: "READY", recovery: "IDLE" });
      this.recordDiagnosticEvent("WDA_READY", { checkedAt });
      if (this.status !== "in-use") this.status = "idle";
      return true;
    } catch (error) {
      const failures = (this.readiness.consecutiveFailures ?? 0) + 1;
      const state = failures === 1 ? "SUSPECT"
        : failures < this.readinessFailureThreshold ? "DEGRADED" : "FAILED";
      const code = error?.name === "TimeoutError" || error?.name === "AbortError" ? "W201" : "W204";
      const detail = diagnosticError(code, {
        why: readinessFailureWhy(error),
        technical: {
          reason: error?.readinessReason || error?.code || error?.name || "request_failed",
          httpStatus: error?.httpStatus,
          timeoutMs: this.timeoutMs,
          consecutiveFailures: failures,
        },
        at: checkedAt,
      });
      this.readiness = {
        ready: false,
        state,
        checkedAt,
        lastHealthyAt: this.readiness.lastHealthyAt ?? null,
        consecutiveFailures: failures,
        lastError: detail,
      };
      this.setComponentHealth({
        wdaEndpoint: state,
        control: state === "FAILED" ? "UNAVAILABLE" : "DEGRADED",
      });
      this.recordDiagnosticEvent("WDA_HEALTH_CHECK_FAILED", {
        checkedAt, error: detail, consecutiveFailures: failures,
      });
      // A single transient endpoint failure is evidence of degraded health,
      // not evidence that the physical phone disappeared. Preserve a phone
      // that was already usable until the configured repeated-failure
      // threshold is reached. A never-ready phone starts offline and stays so.
      if (failures >= this.readinessFailureThreshold && this.status !== "in-use") this.status = "offline";
      return false;
    }
  }

  setComponentHealth(patch = {}) {
    this.componentHealth = { ...this.componentHealth, ...patch };
    return this.componentHealth;
  }

  recordDiagnosticEvent(type, detail = {}) {
    const event = { type, at: new Date().toISOString(), ...detail };
    this.diagnosticEvents.push(event);
    if (this.diagnosticEvents.length > 50) this.diagnosticEvents.shift();
    return event;
  }

  beginRecovery(component) {
    this.readiness = { ...this.readiness, ready: false, state: "RECOVERING", consecutiveFailures: 0 };
    this.setComponentHealth({ wdaEndpoint: "RECOVERING", control: "DEGRADED", recovery: component });
    this.recordDiagnosticEvent("WDA_RECOVERING", { component });
  }

  healthSnapshot() {
    return {
      ...this.componentHealth,
      readiness: { ...this.readiness },
      latestError: this.readiness.lastError ?? null,
      recentEvents: this.diagnosticEvents.slice(-10),
    };
  }

  async ensureSession() {
    if (this.sessionId) return this.sessionId;
    if (this.sessionPromise) return this.sessionPromise;

    const generation = this.sessionGeneration;
    let operation;
    operation = (async () => {
      try {
        const res = await fetch(`${this.baseUrl}/session`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ capabilities: { alwaysMatch: {}, firstMatch: [{}] } }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!res.ok) throw new Error(`WDA session create failed: HTTP ${res.status}`);
        const body = await res.json();
        const sessionId = body.sessionId || body.value?.sessionId;
        if (!sessionId) throw new Error("WDA session create returned no sessionId");
        if (this.sessionGeneration !== generation) throw new Error("WDA session was invalidated while being created");
        this.sessionId = sessionId;
        return sessionId;
      } catch (error) {
        if (this.sessionGeneration === generation) {
          this.sessionId = null;
          this.windowSize = null;
          this.sessionGeneration += 1;
        }
        throw error;
      } finally {
        if (this.sessionPromise === operation) this.sessionPromise = null;
      }
    })();
    this.sessionPromise = operation;
    return operation;
  }

  async ensureWindowSize({ authorize } = {}) {
    // Orientation may change without invalidating the WDA session.
    // Read current dimensions at every coordinate transformation.
    const id = await this.ensureSession();
    assertAuthorized(authorize);
    const res = await fetch(`${this.baseUrl}/session/${id}/window/size`, {
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`WDA window/size failed: HTTP ${res.status}`);
    const body = await res.json();
    assertAuthorized(authorize);
    if (!validWindowSize(body.value)) throw new Error("WDA window/size returned invalid dimensions");
    if (this.sessionId !== id) throw new Error("WDA session changed during window/size lookup");
    this.windowSize = body.value;
    return this.windowSize;
  }

  // A cached sessionId can go bad server-side (WDA restarted, the app
  // crashed, the session timed out) without this object ever finding out —
  // the next call would just keep reusing a dead ID forever. Any failure
  // here invalidates the cache so the *next* attempt starts a fresh
  // session instead of retrying with the same broken one.
  invalidateSession(expectedSessionId = null) {
    if (expectedSessionId !== null && this.sessionId !== expectedSessionId) return false;
    this.sessionGeneration += 1;
    this.sessionId = null;
    this.windowSize = null;
    return true;
  }

  async tap(xNorm, yNorm, { authorize } = {}) {
    let id = null;
    try {
      id = await this.ensureSession();
      assertAuthorized(authorize);
      const { width, height } = await this.ensureWindowSize({ authorize });
      assertAuthorized(authorize);
      const res = await fetch(`${this.baseUrl}/session/${id}/wda/tap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ x: xNorm * width, y: yNorm * height }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) throw new Error(`WDA tap failed: HTTP ${res.status}`);
    } catch (err) {
      if (err?.code !== "DEVICE_ACCESS_REVOKED" && typeof authorize === "function" && authorize() !== true) {
        throw new WdaAuthorizationError();
      }
      if (err?.code !== "DEVICE_ACCESS_REVOKED" && id !== null) this.invalidateSession(id);
      throw err;
    }
  }

  // Retries a tap that either fails outright (network blip) or whose result
  // fails an optional `verify` check. `verify` is supplied by the caller,
  // not this class — it's the platform-specific "did this actually take"
  // signal (e.g. "did the save icon fill in"), which isn't known yet. Until
  // that's specified, omitting `verify` still gets you retry-on-failure,
  // which is the part that's ready today.
  async tapVerified(xNorm, yNorm, { verify, retries = 2, delayMs = 500 } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await this.tap(xNorm, yNorm);
        if (!verify || (await verify())) return;
        lastErr = new Error("tap did not verify");
      } catch (err) {
        lastErr = err;
      }
      if (attempt < retries) await new Promise((r) => setTimeout(r, delayMs));
    }
    throw lastErr;
  }

  async swipe(direction, { x, y, velocity, authorize } = {}) {
    let id = null;
    try {
      id = await this.ensureSession();
      assertAuthorized(authorize);
      const body = { direction };
      if (x != null && y != null) {
        const { width, height } = await this.ensureWindowSize({ authorize });
        body.x = x * width;
        body.y = y * height;
      }
      if (velocity != null) body.velocity = velocity;
      assertAuthorized(authorize);
      const res = await fetch(`${this.baseUrl}/session/${id}/wda/swipe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) throw new Error(`WDA swipe failed: HTTP ${res.status}`);
    } catch (err) {
      if (err?.code !== "DEVICE_ACCESS_REVOKED" && typeof authorize === "function" && authorize() !== true) {
        throw new WdaAuthorizationError();
      }
      if (err?.code !== "DEVICE_ACCESS_REVOKED" && id !== null) this.invalidateSession(id);
      throw err;
    }
  }

  async typeText(text, { authorize } = {}) {
    let id = null;
    try {
      id = await this.ensureSession();
      assertAuthorized(authorize);
      const res = await fetch(`${this.baseUrl}/session/${id}/wda/keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: [text] }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) throw new Error(`WDA keys failed: HTTP ${res.status}`);
    } catch (err) {
      if (err?.code !== "DEVICE_ACCESS_REVOKED" && typeof authorize === "function" && authorize() !== true) {
        throw new WdaAuthorizationError();
      }
      if (err?.code !== "DEVICE_ACCESS_REVOKED" && id !== null) this.invalidateSession(id);
      throw err;
    }
  }

  // Unlike tap/swipe/typeText, real WDA registers this route `.withoutSession`
  // (confirmed in ../../../research/WebDriverAgent's FBCustomCommands.m) —
  // pressing the hardware Home button isn't scoped to a driver session, so
  // this hits `/wda/homescreen` directly with no session id in the path, and
  // doesn't need ensureSession()/ensureWindowSize() first.
  async pressHome({ authorize } = {}) {
    try {
      assertAuthorized(authorize);
      const res = await fetch(`${this.baseUrl}/wda/homescreen`, {
        method: "POST",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) throw new Error(`WDA homescreen failed: HTTP ${res.status}`);
    } catch (err) {
      if (err?.code !== "DEVICE_ACCESS_REVOKED" && typeof authorize === "function" && authorize() !== true) {
        throw new WdaAuthorizationError();
      }
      if (err?.code !== "DEVICE_ACCESS_REVOKED") this.invalidateSession();
      throw err;
    }
  }

  async render({ authorize } = {}) {
    let id = null;
    try {
      id = await this.ensureSession();
      assertAuthorized(authorize);
      const res = await fetch(`${this.baseUrl}/session/${id}/screenshot`, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) throw new Error(`WDA screenshot failed: HTTP ${res.status}`);
      const body = await res.json();
      return { kind: "image", mime: "image/png", data: body.value };
    } catch (err) {
      if (err?.code !== "DEVICE_ACCESS_REVOKED" && typeof authorize === "function" && authorize() !== true) {
        throw new WdaAuthorizationError();
      }
      if (err?.code !== "DEVICE_ACCESS_REVOKED" && id !== null) this.invalidateSession(id);
      throw err;
    }
  }

  // ---- gestures (all coordinates normalized 0..1 like tap/swipe) ---------------

  // One authorized, session-scoped WDA gesture call. Same failure contract as
  // tap/swipe: a revoked authorization wins over a transport error, and any
  // failure invalidates the cached session so the next attempt starts fresh.
  async _gesture(route, buildBody, authorize) {
    let id = null;
    try {
      id = await this.ensureSession();
      assertAuthorized(authorize);
      const size = await this.ensureWindowSize({ authorize });
      assertAuthorized(authorize);
      const res = await fetch(`${this.baseUrl}/session/${id}/wda/${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildBody(size)),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) throw new Error(`WDA ${route} failed: HTTP ${res.status}`);
    } catch (err) {
      if (err?.code !== "DEVICE_ACCESS_REVOKED" && typeof authorize === "function" && authorize() !== true) {
        throw new WdaAuthorizationError();
      }
      if (err?.code !== "DEVICE_ACCESS_REVOKED" && id !== null) this.invalidateSession(id);
      throw err;
    }
  }

  // Finger down at (x1,y1), hold for `holdSec`, drag to (x2,y2), finger up. WDA's
  // handleDrag calls XCUICoordinate pressForDuration:thenDragToCoordinate:, so
  // `duration` is the press-and-hold BEFORE the drag, not the drag time (the drag
  // speed is XCUITest's own). A short hold scrolls a list; a hold of ~0.5s+ turns
  // the same gesture into a press-and-drag (re-ordering icons, selecting text).
  async drag(x1, y1, x2, y2, holdSec = 0.05, { authorize } = {}) {
    return this._gesture("dragfromtoforduration", ({ width, height }) => ({
      fromX: x1 * width, fromY: y1 * height, toX: x2 * width, toY: y2 * height, duration: holdSec,
    }), authorize);
  }

  async longPress(x, y, durationSec = 0.8, { authorize } = {}) {
    return this._gesture("touchAndHold", ({ width, height }) => ({ x: x * width, y: y * height, duration: durationSec }), authorize);
  }

  async doubleTap(x, y, { authorize } = {}) {
    return this._gesture("doubleTap", ({ width, height }) => ({ x: x * width, y: y * height }), authorize);
  }

  // ---- live video (WDA MJPEG server, forwarded by iproxy) ---------------------

  get supportsStream() {
    return this.mjpegPort !== null;
  }

  // Best effort: WDA applies these to the MJPEG server it is running.
  async configureStreaming(profile = defaultStreamProfile()) {
    const id = await this.ensureSession();
    const res = await fetch(`${this.baseUrl}/session/${id}/appium/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings: {
        mjpegServerFramerate: profile.framerate,
        mjpegScalingFactor: profile.scalingFactor,
        mjpegServerScreenshotQuality: profile.quality,
      } }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`WDA settings failed: HTTP ${res.status}`);
  }

  // Starts pulling frames and keeps going until close(): a dropped connection or
  // a stream that stops producing frames (frozen phone, locked screen) is
  // reconnected with backoff, and onState reports connecting/live/reconnecting.
  openStream({ onFrame, onState = () => {}, fetchImpl = fetch, reconnectDelayMs = 1000, maxReconnectDelayMs = 10_000, stallMs = 8000 } = {}) {
    if (!this.supportsStream) throw new Error("this WDA device has no MJPEG port configured");
    let closed = false;
    let controller = null;
    let stallTimer = null;
    let wake = null;
    const url = `http://${this.host}:${this.mjpegPort}/`;

    const run = async () => {
      let delay = reconnectDelayMs;
      while (!closed) {
        controller = new AbortController();
        let reported = false;
        onState("connecting");
        try {
          await this.configureStreaming().catch(() => {});
          const res = await fetchImpl(url, { signal: controller.signal });
          if (!res.ok || !res.body) throw new Error(`MJPEG stream HTTP ${res.status}`);
          const parser = new MjpegParser();
          const armStall = () => {
            clearTimeout(stallTimer);
            stallTimer = setTimeout(() => controller.abort(), stallMs);
          };
          armStall();
          for await (const chunk of res.body) {
            if (closed) break;
            for (const frame of parser.push(chunk)) {
              armStall();
              delay = reconnectDelayMs;
              onFrame(frame);
            }
          }
        } catch (error) {
          if (closed) break;
          reported = true;
          onState("reconnecting", error?.name === "AbortError" ? "stream stalled" : error?.message);
        } finally {
          clearTimeout(stallTimer);
        }
        if (closed) break;
        if (!reported) onState("reconnecting", "stream ended");
        await new Promise(resolve => {
          const timer = setTimeout(resolve, delay);
          wake = () => { clearTimeout(timer); resolve(); };
        });
        wake = null;
        delay = Math.min(delay * 2, maxReconnectDelayMs);
      }
      onState("closed");
    };
    void run();
    return {
      close: () => {
        closed = true;
        controller?.abort();
        clearTimeout(stallTimer);
        wake?.();
      },
    };
  }

  async getUiTree() {
    try {
      const id = await this.ensureSession();
      const res = await fetch(`${this.baseUrl}/session/${id}/source`, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) throw new Error(`WDA source failed: HTTP ${res.status}`);
      const body = await res.json();
      if (body.value === null || body.value === undefined) throw new Error("WDA source returned no value");
      return body.value;
    } catch (err) {
      this.invalidateSession();
      throw err;
    }
  }
}
