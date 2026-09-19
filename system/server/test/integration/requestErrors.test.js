// A request the server cannot parse is the caller's mistake: 400 or 413 with a clear code, never a 500 "request
// failed" (found by fuzzing every JSON route with a malformed, null and oversized body).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-request-errors-"));
Object.assign(process.env, {
  SESSION_STORE_DIR: path.join(root, "sessions"),
  AUDIT_LOG_PATH: path.join(root, "audit.log"),
  QUEUE_STORE_PATH: path.join(root, "queue.json"),
  RESEARCH_STORE_DIR: path.join(root, "research"),
  RESEARCH_EVIDENCE_DIR: path.join(root, "evidence"),
  RESEARCH_CONFIG_PATH: path.join(root, "research.config.json"),
  OPERATORS_CONFIG_PATH: path.join(root, "operators.config.json"),
  FILE_STORE_DIR: path.join(root, "files"),
  SITE_STORE_PATH: path.join(root, "sites.json"),
  APPROVAL_STORE_PATH: path.join(root, "approvals.json"),
  COMMENT_LEDGER_PATH: path.join(root, "ledger.json"),
  COMMENT_TEMPLATES_PATH: path.join(root, "templates.json"),
  ACTION_POLICY_OVERRIDES_PATH: path.join(root, "policy.json"),
  INTERVENTION_STORE_PATH: path.join(root, "interventions.json"),
  MODEL_SELECTION_STORE_PATH: path.join(root, "models.json"),
  ASSIGNMENT_STORE_PATH: path.join(root, "assignments.json"),
  SESSION_SECRET: "isolated-test-secret",
});
fs.writeFileSync(process.env.RESEARCH_CONFIG_PATH, JSON.stringify({ accounts: [] }));
fs.writeFileSync(process.env.OPERATORS_CONFIG_PATH, JSON.stringify({ operators: [] }));
const { server, wss } = await import("../../src/index.js");

let base;
before(async () => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  wss.close();
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
});

const post = (route, body, type = "application/json") =>
  fetch(`${base}${route}`, { method: "POST", headers: { "Content-Type": type }, body });

for (const route of ["/api/login", "/api/signup", "/api/setup/create-admin"]) {
  test(`${route}: a body that is not JSON is a 400 with a code, not a 500`, async () => {
    const response = await post(route, '{"username":');
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "the request body is not valid JSON", code: "INVALID_JSON" });
  });

  test(`${route}: a bare null body is rejected as a 400`, async () => {
    const response = await post(route, "null");
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "INVALID_JSON");
  });

  test(`${route}: an oversized body is a 413`, async () => {
    const response = await post(route, JSON.stringify({ text: "A".repeat(2_000_000) }));
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { error: "the request body is too large", code: "PAYLOAD_TOO_LARGE" });
  });
}

test("valid JSON is still handled by the route (the fix only touches unreadable requests)", async () => {
  const response = await post("/api/login", JSON.stringify({ username: "nobody", password: "wrong-password-1" }));
  assert.ok([400, 401].includes(response.status), `expected the route's own answer, got ${response.status}`);
  assert.notEqual((await response.json()).code, "INVALID_JSON");
});

test("the error response never echoes the parser's message or the offending input", async () => {
  const response = await post("/api/login", '{"password":"hunter2-secret-value",');
  const text = await response.text();
  assert.equal(response.status, 400);
  assert.doesNotMatch(text, /hunter2|Unexpected|position|token/i);
});
