import { test } from "node:test";
import assert from "node:assert/strict";
import { captureObservation, observationForText } from "../../src/observationPackage.js";

const now = () => new Date("2026-09-09T10:00:00.000Z");

test("prefers a non-empty UI tree and does not capture a screenshot", async () => {
  let renders = 0;
  const device = { id: "mock-1", getUiTree: async () => ({ screen: "feed" }), render: async () => { renders++; } };
  const result = await captureObservation(device, { goal: "Find hooks", platform: "instagram", accountId: "account-a", taskId: "task-1", now });
  assert.equal(result.source, "ui_tree");
  assert.deepEqual(result.ui_tree, { screen: "feed" });
  assert.equal(result.screenshot, null);
  assert.equal(renders, 0);
  assert.equal(result.captured_at, "2026-09-09T10:00:00.000Z");
});

for (const [name, getUiTree] of [
  ["missing", undefined], ["empty", async () => ""], ["failed", async () => { throw new Error("source unavailable"); }],
]) {
  test(`uses a screenshot when UI-tree capture is ${name}`, async () => {
    const device = { id: "wda-1", getUiTree, render: async () => ({ kind: "image", mime: "image/png", data: Buffer.from("png").toString("base64") }) };
    const result = await captureObservation(device, { goal: "Observe", now });
    assert.equal(result.source, "screenshot");
    assert.equal(result.screenshot.mime, "image/png");
    assert.match(result.ui_tree_error, name === "failed" ? /source unavailable/ : /UI tree|does not expose/);
    assert.match(result.screenshot_ref, /^observation:wda-1:/);
  });
}

test("oversize UI trees fall back and oversize/unsupported screenshots are rejected", async () => {
  const device = { id: "dev", getUiTree: async () => "too large", render: async () => ({ kind: "image", mime: "image/gif", data: "AAAA" }) };
  await assert.rejects(() => captureObservation(device, { goal: "Observe", maxUiTreeBytes: 2, now }), /supported image frame/);
  device.render = async () => ({ kind: "image", mime: "image/png", data: Buffer.alloc(5).toString("base64") });
  await assert.rejects(() => captureObservation(device, { goal: "Observe", maxUiTreeBytes: 2, maxScreenshotBytes: 4, now }), /size must be/);
});

test("screenshot fallback rejects malformed base64 before a provider can receive it", async () => {
  const device = { id: "dev", render: async () => ({ kind: "image", mime: "image/png", data: "not!base64" }) };
  await assert.rejects(() => captureObservation(device, { goal: "Observe", now }), /invalid base64/);
});

test("validates required context and removes image bytes from text metadata", async () => {
  await assert.rejects(() => captureObservation({ id: "dev" }, { goal: "" }), /non-empty goal/);
  const observation = { goal: "x", screenshot_ref: "ref", screenshot: { data: "secret-image-bytes" } };
  assert.deepEqual(observationForText(observation), { goal: "x", screenshot_ref: "ref" });
  assert.equal(observation.screenshot.data, "secret-image-bytes");
});
