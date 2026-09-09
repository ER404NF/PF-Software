// Stands in for a real model vendor's HTTP API so anthropicProvider.js and
// openAiCompatibleProvider.js can be exercised end-to-end without any real
// API key or network call to a live vendor. Mirrors fake-wda-server.js /
// fake-network-check-server.js: same ephemeral-port-friendly startup, same
// /debug/* control surface.
//
// Serves both a /v1/messages route (Anthropic Messages API shape) and a
// /chat/completions route (the OpenAI-compatible chat-completions shape
// shared by OpenAI/DeepSeek/Kimi/NVIDIA NIM) — one fixture covers both
// adapters this milestone requires (docs/CODING_ROADMAP.md MS8.1.4).
//
// Lives outside server/test/ deliberately, like the other fixtures — Node's
// test runner treats every file under a directory literally named "test"/
// "tests" as a test file, and this is a long-running server, not a test.
//
// Run: node server/fixtures/fake-model-server.js [port]

import express from "express";

const PORT = process.argv[2] === undefined ? 8399 : Number(process.argv[2]);
const app = express();
app.use(express.json());

const DEFAULT_DECISION = {
  screen_state: "instagram_reel",
  goal_progress: "candidate_found",
  action: "observe",
  target: "current_post",
  reason: "Strong hook in the first 3 seconds",
  confidence: 0.9,
  candidate: { platform_content_id: "fixture-post-1", canonical_url: "https://example.com/fixture-post-1" },
};

let decisionText = JSON.stringify(DEFAULT_DECISION);
let statusCode = 200;
let requiredApiKey = null; // null = don't check
let history = [];

app.post("/v1/messages", (req, res) => {
  history.push({ type: "anthropic", headers: req.headers, body: req.body });
  if (requiredApiKey && req.get("x-api-key") !== requiredApiKey) {
    return res.status(401).json({ error: "bad api key" });
  }
  if (statusCode !== 200) return res.status(statusCode).json({ error: "injected failure" });
  res.json({ content: [{ type: "text", text: decisionText }] });
});

app.post("/chat/completions", (req, res) => {
  history.push({ type: "openai-compatible", headers: req.headers, body: req.body });
  if (requiredApiKey && req.get("authorization") !== `Bearer ${requiredApiKey}`) {
    return res.status(401).json({ error: "bad api key" });
  }
  if (statusCode !== 200) return res.status(statusCode).json({ error: "injected failure" });
  res.json({ choices: [{ message: { content: decisionText } }] });
});

app.get("/debug/history", (req, res) => res.json({ history }));

app.post("/debug/set-decision-text", (req, res) => {
  const { text } = req.body || {};
  if (typeof text !== "string") return res.status(400).json({ error: "text is required" });
  decisionText = text;
  res.json({ ok: true });
});

app.post("/debug/set-status", (req, res) => {
  const { status } = req.body || {};
  if (typeof status !== "number") return res.status(400).json({ error: "status is required" });
  statusCode = status;
  res.json({ ok: true });
});

app.post("/debug/require-api-key", (req, res) => {
  const { key } = req.body || {};
  requiredApiKey = typeof key === "string" ? key : null;
  res.json({ ok: true });
});

app.post("/debug/reset", (req, res) => {
  decisionText = JSON.stringify(DEFAULT_DECISION);
  statusCode = 200;
  requiredApiKey = null;
  history = [];
  res.json({ ok: true });
});

const server = app.listen(PORT, () => {
  // server.address().port, not the raw PORT var — correct when PORT=0 asks
  // the OS for an ephemeral port, same TIME_WAIT-avoidance reasoning as the
  // other fixtures' own comments explain.
  console.log(`[fake-model-server] listening on http://127.0.0.1:${server.address().port}`);
});

export { app, server };
