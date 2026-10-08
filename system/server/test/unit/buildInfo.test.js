import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { loadBuildInfo } from "../../src/buildInfo.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bodun-build-info-"));
const write = (name, text) => { const file = path.join(dir, name); fs.writeFileSync(file, text); return file; };

test("an installed build reports its commit and build date", () => {
  const file = write("ok.json", JSON.stringify({ commit: "A1B2C3D", builtAt: "2026-10-07T09:30:00.000Z" }));
  assert.deepEqual(loadBuildInfo(file), { buildId: "a1b2c3d", builtAt: "2026-10-07T09:30:00.000Z" });
});

test("a development run (no file) or a damaged file simply has no build id", () => {
  assert.deepEqual(loadBuildInfo(path.join(dir, "missing.json")), { buildId: null, builtAt: null });
  assert.deepEqual(loadBuildInfo(write("bad.json", "{not json")), { buildId: null, builtAt: null });
  assert.deepEqual(loadBuildInfo(write("odd.json", JSON.stringify({ commit: "<script>alert(1)</script>", builtAt: "yesterday" }))), { buildId: null, builtAt: null });
});

test("a build whose commit could not be found says nothing rather than guessing", () => {
  const file = write("unknown.json", JSON.stringify({ commit: "unknown", builtAt: "2026-10-07T09:30:00.000Z" }));
  assert.deepEqual(loadBuildInfo(file), { buildId: null, builtAt: "2026-10-07T09:30:00.000Z" });
});

test("the badge shows the build id after the version and the tooltip shows the date", () => {
  const app = fs.readFileSync(new URL("../../../client/app.js", import.meta.url), "utf8");
  assert.match(app, /appVersionEl\.textContent = `v\$\{displayVersion\}\$\{body\.buildId \? ` · \$\{body\.buildId\}` : ""\}`;/);
  assert.match(app, /built \$\{new Date\(body\.builtAt\)\.toLocaleDateString\(\)\}/);
  assert.match(fs.readFileSync(new URL("../../src/index.js", import.meta.url), "utf8"), /buildId: applicationBuild\.buildId,\s*builtAt: applicationBuild\.builtAt,/);
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
