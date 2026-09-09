import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { assertProviderContract } from "../../src/modelProvider.js";
import { AnthropicProvider } from "../../src/anthropicProvider.js";
import { OpenAiCompatibleProvider } from "../../src/openAiCompatibleProvider.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, "../../fixtures/fake-model-server.js");

let child;
let BASE_URL;

// Same ephemeral-port spawn pattern as wdaDevice.test.js, for the same
// TIME_WAIT-avoidance reason documented there.
function spawnFakeModelServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [fixturePath, "0"], { stdio: "pipe" });
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk.toString();
      const match = buffer.match(/\[fake-model-server\] listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        proc.stdout.off("data", onData);
        resolve({ proc, baseUrl: `http://127.0.0.1:${match[1]}` });
      }
    };
    proc.stdout.on("data", onData);
    proc.on("error", reject);
  });
}

before(async () => {
  const { proc, baseUrl } = await spawnFakeModelServer();
  child = proc;
  BASE_URL = baseUrl;
});

after(() => {
  child.kill();
});

beforeEach(async () => {
  await fetch(`${BASE_URL}/debug/reset`, { method: "POST" });
});

async function getHistory() {
  return fetch(`${BASE_URL}/debug/history`).then((r) => r.json()).then((b) => b.history);
}

// This is MS8.1.6's own required test, run against both adapters this
// milestone builds — same fixture in, same schema-valid StructuredDecision
// shape out, regardless of vendor, proving the interface genuinely hides
// the vendor-specific wire format from callers.
for (const [label, makeProvider] of [
  ["AnthropicProvider", () => new AnthropicProvider({ baseUrl: BASE_URL, model: "claude-test", apiKey: "test-key" })],
  ["OpenAiCompatibleProvider", () => new OpenAiCompatibleProvider({ name: "openai-compatible", baseUrl: BASE_URL, model: "gpt-test", apiKey: "test-key" })],
]) {
  test(`${label} passes the provider contract test against a fixture endpoint`, async () => {
    await assertProviderContract(makeProvider());
  });

  test(`${label} throws a clear error without a configured API key`, async () => {
    const provider = makeProvider();
    provider.apiKey = null;
    await assert.rejects(() => provider.observeAndPlan({}), /no API key configured/);
  });

  test(`${label} throws on a non-2xx response instead of returning a malformed decision`, async () => {
    await fetch(`${BASE_URL}/debug/set-status`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: 500 }) });
    await assert.rejects(() => makeProvider().observeAndPlan({}), /HTTP 500/);
  });

  test(`${label} throws a clear error when the model's reply isn't valid JSON`, async () => {
    await fetch(`${BASE_URL}/debug/set-decision-text`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "not json" }) });
    await assert.rejects(() => makeProvider().observeAndPlan({}), /response was not valid JSON/);
  });

  test(`${label} throws when the model's reply is valid JSON but not a valid decision`, async () => {
    await fetch(`${BASE_URL}/debug/set-decision-text`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: JSON.stringify({ nonsense: true }) }) });
    await assert.rejects(() => makeProvider().observeAndPlan({}), /missing required string field/);
  });
}

test("AnthropicProvider sends the API key as x-api-key and the observation as the user message", async () => {
  await fetch(`${BASE_URL}/debug/require-api-key`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: "secret-1" }) });
  const provider = new AnthropicProvider({ baseUrl: BASE_URL, model: "claude-test", apiKey: "secret-1" });
  await provider.observeAndPlan({ goal: "test-goal" });
  const [call] = await getHistory();
  assert.equal(call.type, "anthropic");
  assert.equal(call.headers["x-api-key"], "secret-1");
  assert.equal(call.headers["anthropic-version"], "2023-06-01");
  assert.equal(call.body.model, "claude-test");
  assert.ok(JSON.parse(call.body.messages[0].content).goal === "test-goal");
});

test("AnthropicProvider rejects an unauthorized API key the same way a real vendor would", async () => {
  await fetch(`${BASE_URL}/debug/require-api-key`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: "secret-1" }) });
  const provider = new AnthropicProvider({ baseUrl: BASE_URL, model: "claude-test", apiKey: "wrong-key" });
  await assert.rejects(() => provider.observeAndPlan({}), /HTTP 401/);
});

test("OpenAiCompatibleProvider sends the API key as a Bearer token and the observation as the user message", async () => {
  await fetch(`${BASE_URL}/debug/require-api-key`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: "secret-2" }) });
  const provider = new OpenAiCompatibleProvider({ name: "deepseek", baseUrl: BASE_URL, model: "deepseek-chat", apiKey: "secret-2" });
  await provider.observeAndPlan({ goal: "test-goal-2" });
  const [call] = await getHistory();
  assert.equal(call.type, "openai-compatible");
  assert.equal(call.headers.authorization, "Bearer secret-2");
  assert.equal(call.body.model, "deepseek-chat");
  assert.equal(call.body.messages[0].role, "system");
  assert.ok(JSON.parse(call.body.messages[1].content).goal === "test-goal-2");
});

test("both adapters send screenshot fallbacks as vendor-native image input without duplicating bytes in text", async () => {
  const observation = { goal: "visual check", source: "screenshot", screenshot_ref: "observation:dev:time",
    screenshot: { kind: "image", mime: "image/png", data: "aW1hZ2U=" } };
  const anthropic = new AnthropicProvider({ baseUrl: BASE_URL, model: "claude-test", apiKey: "key" });
  const openai = new OpenAiCompatibleProvider({ name: "openai", baseUrl: BASE_URL, model: "gpt-test", apiKey: "key" });
  await anthropic.observeAndPlan(observation);
  await openai.observeAndPlan(observation);
  const [anthropicCall, openaiCall] = await getHistory();

  const anthropicContent = anthropicCall.body.messages[0].content;
  assert.equal(anthropicContent[1].type, "image");
  assert.equal(anthropicContent[1].source.data, "aW1hZ2U=");
  assert.equal(JSON.parse(anthropicContent[0].text).screenshot, undefined);

  const openaiContent = openaiCall.body.messages[1].content;
  assert.equal(openaiContent[1].type, "image_url");
  assert.equal(openaiContent[1].image_url.url, "data:image/png;base64,aW1hZ2U=");
  assert.equal(JSON.parse(openaiContent[0].text).screenshot, undefined);
});

test("OpenAiCompatibleProvider requires a baseUrl at construction, not just at call time", () => {
  assert.throws(() => new OpenAiCompatibleProvider({ name: "no-base-url", model: "x", apiKey: "k" }), /baseUrl is required/);
});
