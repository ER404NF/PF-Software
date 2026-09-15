// Stands in for a real WebDriverAgent instance so WdaDevice's HTTP calls can
// be exercised end-to-end before any hardware exists. Implements the routes
// WdaDevice uses, matching the request/response shapes confirmed against the
// real WDA source in ../../../research/WebDriverAgent.
//
// Lives outside server/test/ deliberately: Node's test runner treats every
// file under a directory literally named "test"/"tests" as a test file, and
// this is a long-running server, not a test — putting it there would make
// `npm test` hang.
//
// Run: node server/fixtures/fake-wda-server.js [port]
// Then point a devices.config.json entry at { "type": "wda", "port": <port> }.

import express from "express";

// Distinguishes "no argument" (default to 8199) from an explicit "0" (ask
// the OS for an ephemeral port) — `Number(x) || 8199` would collapse both to
// 8199, since 0 is falsy.
const PORT = process.argv[2] === undefined ? 8199 : Number(process.argv[2]);
const app = express();
app.use(express.json());

// A 1x1 PNG — the point here is exercising the request/response shapes,
// not producing a meaningful image.
const FAKE_SCREENSHOT =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

let sessionCounter = 0;

// Ordered record of every request received (session/window-size/tap/swipe/
// keys/screenshot), so a test can assert not just content but arrival order
// — e.g. proving a slow tap's screenshot round trip fully completes before a
// second tap is even sent, which is what index.js's per-connection action
// queue is supposed to guarantee.
const history = [];

// Set via /debug/hang, cleared via /debug/unhang. When true, every WDA route
// below simply never responds — this is what lets a test prove a hung real
// device gets timed out client-side instead of stalling forever.
let hanging = false;

// Set via /debug/delay {ms}. Applied to every WDA route below before it
// responds, to create a real timing window for ordering tests without
// relying on incidental network jitter.
let responseDelayMs = 0;
let ready = true;
let failNextScreenshot = false;

function record(type, extra = {}) {
  history.push({ type, at: new Date().toISOString(), ...extra });
}

async function respond(req, res, type, extra, send) {
  record(type, extra);
  if (hanging) return;
  if (responseDelayMs > 0) await new Promise((r) => setTimeout(r, responseDelayMs));
  send();
}

app.post("/session", (req, res) => {
  sessionCounter += 1;
  const sessionId = `fake-session-${sessionCounter}`;
  console.log(`[fake-wda] session created: ${sessionId}`);
  respond(req, res, "session", {}, () => res.json({ sessionId, value: { sessionId } }));
});

app.get("/status", (req, res) => {
  respond(req, res, "status", {}, () => res.json({ value: { ready } }));
});

app.get("/session/:id/window/size", (req, res) => {
  respond(req, res, "window-size", {}, () => res.json({ value: { width: 375, height: 667 } }));
});

app.post("/session/:id/wda/tap", (req, res) => {
  console.log(`[fake-wda] tap received: x=${req.body.x} y=${req.body.y}`);
  respond(req, res, "tap", { x: req.body.x, y: req.body.y }, () => res.json({ value: null }));
});

app.post("/session/:id/wda/swipe", (req, res) => {
  console.log(`[fake-wda] swipe received: direction=${req.body.direction}`);
  respond(
    req,
    res,
    "swipe",
    { direction: req.body.direction, x: req.body.x, y: req.body.y, velocity: req.body.velocity },
    () => res.json({ value: null })
  );
});

app.post("/session/:id/wda/keys", (req, res) => {
  console.log(`[fake-wda] keys received: value=${JSON.stringify(req.body.value)}`);
  respond(req, res, "keys", { value: req.body.value }, () => res.json({ value: null }));
});

app.get("/session/:id/screenshot", (req, res) => {
  respond(req, res, "screenshot", {}, () => {
    if (failNextScreenshot) {
      failNextScreenshot = false;
      res.status(500).json({ value: { error: "screenshot failed" } });
    } else res.json({ value: FAKE_SCREENSHOT });
  });
});

app.get("/session/:id/source", (req, res) => {
  respond(req, res, "source", {}, () => res.json({ value: "<Application name=\"Fake\"><Button label=\"Research\"/></Application>" }));
});

// Real WDA registers this `.withoutSession` (FBCustomCommands.m) — pressing
// the hardware Home button isn't scoped to a driver session the way tap/
// swipe/keys are, so unlike those routes this has no `:id` in its path.
app.post("/wda/homescreen", (req, res) => {
  console.log("[fake-wda] homescreen received");
  respond(req, res, "homescreen", {}, () => res.json({ value: null }));
});

// Not part of the real WDA API — lets a test script assert what the fake
// server actually received, without scraping console output.
app.get("/debug/last-tap", (req, res) => {
  const lastTap = [...history].reverse().find((h) => h.type === "tap") || null;
  res.json({ lastTap });
});

app.get("/debug/history", (req, res) => {
  res.json({ history });
});

app.post("/debug/reset", (req, res) => {
  history.length = 0;
  sessionCounter = 0;
  hanging = false;
  responseDelayMs = 0;
  ready = true;
  failNextScreenshot = false;
  res.json({ ok: true });
});

app.post("/debug/ready", (req, res) => {
  ready = req.body?.ready === true;
  res.json({ ok: true, ready });
});

// Delays every subsequent WDA response by `ms` — lets a test create a real
// timing window (e.g. to prove one action's full round trip completes before
// the next is sent) without relying on incidental network jitter.
app.post("/debug/delay", (req, res) => {
  responseDelayMs = Number(req.body.ms) || 0;
  res.json({ ok: true, responseDelayMs });
});

// Simulates a WDA process that's still accepting TCP connections but never
// completes a request (locked screen, crashed-but-not-exited process) — the
// failure mode a client-side fetch timeout exists to catch.
app.post("/debug/hang", (req, res) => {
  hanging = true;
  res.json({ ok: true });
});

app.post("/debug/unhang", (req, res) => {
  hanging = false;
  res.json({ ok: true });
});

app.post("/debug/fail-next-screenshot", (req, res) => {
  failNextScreenshot = true;
  res.json({ ok: true });
});

const server = app.listen(PORT, () => {
  // server.address().port (not the raw PORT var) so this is still correct
  // when PORT=0 asks the OS for an ephemeral port — the test suite spawns
  // this fixture that way precisely to avoid the fixed 8298/8199-style ports
  // colliding via lingering TIME_WAIT sockets under rapid repeated test runs.
  console.log(`[fake-wda] listening on http://127.0.0.1:${server.address().port}`);
});

export { app, server };
