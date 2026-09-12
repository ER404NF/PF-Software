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

export class WdaDevice {
  constructor(id, label, { host = "127.0.0.1", port, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.id = id;
    this.label = label;
    this.status = "idle"; // idle | in-use | offline
    this.baseUrl = `http://${host}:${port}`;
    this.timeoutMs = timeoutMs;
    this.sessionId = null;
    this.windowSize = null;
  }

  async ensureSession() {
    if (this.sessionId) return this.sessionId;
    const res = await fetch(`${this.baseUrl}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capabilities: { alwaysMatch: {}, firstMatch: [{}] } }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`WDA session create failed: HTTP ${res.status}`);
    const body = await res.json();
    this.sessionId = body.sessionId || body.value?.sessionId;
    if (!this.sessionId) throw new Error("WDA session create returned no sessionId");
    return this.sessionId;
  }

  async ensureWindowSize() {
    // Orientation may change without invalidating the WDA session.
    // Read current dimensions at every coordinate transformation.
    const id = await this.ensureSession();
    const res = await fetch(`${this.baseUrl}/session/${id}/window/size`, {
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`WDA window/size failed: HTTP ${res.status}`);
    const body = await res.json();
    this.windowSize = body.value; // { width, height }
    return this.windowSize;
  }

  // A cached sessionId can go bad server-side (WDA restarted, the app
  // crashed, the session timed out) without this object ever finding out —
  // the next call would just keep reusing a dead ID forever. Any failure
  // here invalidates the cache so the *next* attempt starts a fresh
  // session instead of retrying with the same broken one.
  invalidateSession() {
    this.sessionId = null;
    this.windowSize = null;
  }

  async tap(xNorm, yNorm) {
    try {
      const id = await this.ensureSession();
      const { width, height } = await this.ensureWindowSize();
      const res = await fetch(`${this.baseUrl}/session/${id}/wda/tap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ x: xNorm * width, y: yNorm * height }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) throw new Error(`WDA tap failed: HTTP ${res.status}`);
    } catch (err) {
      this.invalidateSession();
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

  async swipe(direction, { x, y, velocity } = {}) {
    try {
      const id = await this.ensureSession();
      const body = { direction };
      if (x != null && y != null) {
        const { width, height } = await this.ensureWindowSize();
        body.x = x * width;
        body.y = y * height;
      }
      if (velocity != null) body.velocity = velocity;
      const res = await fetch(`${this.baseUrl}/session/${id}/wda/swipe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) throw new Error(`WDA swipe failed: HTTP ${res.status}`);
    } catch (err) {
      this.invalidateSession();
      throw err;
    }
  }

  async typeText(text) {
    try {
      const id = await this.ensureSession();
      const res = await fetch(`${this.baseUrl}/session/${id}/wda/keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: [text] }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) throw new Error(`WDA keys failed: HTTP ${res.status}`);
    } catch (err) {
      this.invalidateSession();
      throw err;
    }
  }

  // Unlike tap/swipe/typeText, real WDA registers this route `.withoutSession`
  // (confirmed in ../../../research/WebDriverAgent's FBCustomCommands.m) —
  // pressing the hardware Home button isn't scoped to a driver session, so
  // this hits `/wda/homescreen` directly with no session id in the path, and
  // doesn't need ensureSession()/ensureWindowSize() first.
  async pressHome() {
    try {
      const res = await fetch(`${this.baseUrl}/wda/homescreen`, {
        method: "POST",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) throw new Error(`WDA homescreen failed: HTTP ${res.status}`);
    } catch (err) {
      this.invalidateSession();
      throw err;
    }
  }

  async render() {
    try {
      const id = await this.ensureSession();
      const res = await fetch(`${this.baseUrl}/session/${id}/screenshot`, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) throw new Error(`WDA screenshot failed: HTTP ${res.status}`);
      const body = await res.json();
      return { kind: "image", mime: "image/png", data: body.value };
    } catch (err) {
      this.invalidateSession();
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
