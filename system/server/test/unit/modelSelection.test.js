import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { createModelSelection } from "../../src/modelSelection.js";

test("model selection resolves task, device, workspace, global and config scopes in order", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-model-selection-"));
  const file = path.join(root, "selection.json");
  const providers = new Map(["default", "global", "workspace", "device", "task"].map((name) => [name, { name }]));
  try {
    const selection = createModelSelection({ providers, defaultProviderName: "default", storePath: file });
    assert.equal(selection.resolve(), "default");
    selection.set("global");
    selection.set("workspace", { scope: "workspace", scopeId: "client-a" });
    selection.set("device", { scope: "device", scopeId: "mock-1" });
    selection.set("task", { scope: "task", scopeId: "task_1" });
    assert.equal(selection.resolve({ workspaceId: "client-a" }), "workspace");
    assert.equal(selection.resolve({ workspaceId: "client-a", deviceId: "mock-1" }), "device");
    assert.equal(selection.resolve({ taskId: "task_1", workspaceId: "client-a", deviceId: "mock-1" }), "task");
    const reloaded = createModelSelection({ providers, defaultProviderName: "default", storePath: file });
    assert.equal(reloaded.resolve({ taskId: "task_1" }), "task");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("model selection rejects unknown providers and unsafe scopes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-model-selection-invalid-"));
  try {
    const selection = createModelSelection({ providers: new Map([["one", { name: "one" }]]),
      storePath: path.join(root, "selection.json") });
    assert.throws(() => selection.set("missing"), /unknown/);
    assert.throws(() => selection.set("one", { scope: "workspace", scopeId: "../escape" }), /safe id/);
    assert.throws(() => selection.set("one", { scope: "other", scopeId: "x" }), /invalid model scope/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a persistence failure does not change the live model selection", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-model-selection-fail-"));
  const storePath = path.join(root, "selection.json");
  const providers = new Map([["default", { name: "default" }], ["other", { name: "other" }]]);
  try {
    const selection = createModelSelection({ providers, defaultProviderName: "default", storePath });
    // A directory at the target path makes the final atomic rename fail on
    // every supported filesystem without changing permissions globally.
    fs.mkdirSync(storePath);
    assert.throws(() => selection.set("other"));
    assert.equal(selection.resolve(), "default");
    assert.equal(selection.describe().selections.global, null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
