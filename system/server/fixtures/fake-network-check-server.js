// Stands in for the "what is my egress IP" endpoint networkVerifier.js
// checks each device against — in Phase 1-3 (out of scope here) that's a
// real status endpoint on each VLAN's dedicated LTE modem or an externally-
// reachable IP-echo service; this lets networkVerifier.js be exercised
// end-to-end before any of that hardware exists. Mirrors fake-wda-server.js:
// same ephemeral-port-friendly startup, same /debug/* control surface.
//
// Lives outside server/test/ deliberately, like fake-wda-server.js — Node's
// test runner treats every file under a directory literally named "test"/
// "tests" as a test file, and this is a long-running server, not a test.
//
// Run: node server/fixtures/fake-network-check-server.js [port]

import express from "express";

const PORT = process.argv[2] === undefined ? 8299 : Number(process.argv[2]);
const app = express();
app.use(express.json());

let currentIp = "203.0.113.10"; // TEST-NET-3 (RFC 5737) — obviously not a routable real IP
let hanging = false;

app.get("/ip", (req, res) => {
  if (hanging) return; // never responds — simulates an unreachable check endpoint
  res.json({
    ip: currentIp,
    ipv6: null,
    region: "test-region",
    dnsStatus: "ok",
    proxyHealthy: true,
    bandwidthMbps: 100,
  });
});

// Not part of any real device's API — lets a test control what this fixture
// reports, the same way fake-wda-server.js's /debug/* routes do for WDA.
app.post("/debug/set-ip", (req, res) => {
  const { ip } = req.body || {};
  if (typeof ip !== "string" || ip.length === 0) return res.status(400).json({ error: "ip is required" });
  currentIp = ip;
  res.json({ ok: true, ip: currentIp });
});

app.post("/debug/hang", (req, res) => {
  hanging = true;
  res.json({ ok: true });
});

app.post("/debug/unhang", (req, res) => {
  hanging = false;
  res.json({ ok: true });
});

app.post("/debug/reset", (req, res) => {
  currentIp = "203.0.113.10";
  hanging = false;
  res.json({ ok: true });
});

const server = app.listen(PORT, () => {
  // server.address().port, not the raw PORT var — correct when PORT=0 asks
  // the OS for an ephemeral port, which is how the test suite spawns this,
  // for the same TIME_WAIT-avoidance reasons documented in fake-wda-server.js.
  console.log(`[fake-network-check] listening on http://127.0.0.1:${server.address().port}`);
});

export { app, server };
