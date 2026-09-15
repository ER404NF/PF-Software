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
const DEFAULT_TIMEOUT_MS = 8000;
const MAX_IOS_LOGICAL_DIMENSION = 10000;

export class WdaAuthorizationError extends Error {
  constructor() {
    super("Device authorization changed before the WDA operation could execute.");
    this.name = "WdaAuthorizationError";
    this.code = "DEVICE_ACCESS_REVOKED";
  }
}

function assertAuthorized(authorize) {
  if (typeof authorize === "function" && authorize() !== true) throw new WdaAuthorizationError();
}

function validWindowSize(value) {
  return value && typeof value === "object"
    && Number.isFinite(value.width) && value.width > 0 && value.width <= MAX_IOS_LOGICAL_DIMENSION
    && Number.isFinite(value.height) && value.height > 0 && value.height <= MAX_IOS_LOGICAL_DIMENSION;
}

export class WdaDevice {
  constructor(id, label, { host = "127.0.0.1", port, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.id = id;
    this.label = label;
    this.status = "offline"; // fail closed until /status confirms this WDA endpoint is ready
    this.readiness = { ready: false, checkedAt: null };
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
      if (!response.ok) throw new Error(`WDA readiness failed: HTTP ${response.status}`);
      const body = await response.json();
      const ready = body?.ready === true || body?.value?.ready === true;
      if (!ready) throw new Error("WDA readiness response was not ready");
      this.readiness = { ready: true, checkedAt };
      if (this.status !== "in-use") this.status = "idle";
      return true;
    } catch {
      this.readiness = { ready: false, checkedAt };
      if (this.status !== "in-use") this.status = "offline";
      return false;
    }
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
