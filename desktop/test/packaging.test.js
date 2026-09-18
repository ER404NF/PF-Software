const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { verifyRuntime } = require("../scripts/prepare-runtime.cjs");

test("the currently installed system production runtime is packageable", () => {
  assert.ok(verifyRuntime().length >= 7);
});

test("electron-builder copies system as an extra resource and DMG builds prepare runtime first", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8"));
  assert.ok(packageJson.build.extraResources.some(resource => resource.from === "../system" && resource.to === "system"));
  assert.match(packageJson.scripts["dist:mac"], /prepare:runtime/);
  assert.match(packageJson.scripts["dist:mac"], /electron-builder --mac/);
});
