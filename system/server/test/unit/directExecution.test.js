// Regression: on macOS CI the packaged server was started from /var/folders/... (a symlink to /private/var/...). The
// old "am I the main script" check compared a resolved URL with an unresolved path, decided it was only imported, never
// called listen(), and exited with code 0. These tests use a REAL directory link (a junction on Windows).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { isDirectExecution } from "../../src/directExecution.js";

const helperUrl = pathToFileURL(path.resolve("server/src/directExecution.js")).href;

function scratch(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-direct-"));
  try { return fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function writeEntry(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "entry.mjs");
  fs.writeFileSync(file, `import { isDirectExecution } from ${JSON.stringify(helperUrl)};\nconsole.log("direct=" + isDirectExecution(import.meta.url));\n`);
  return file;
}

const run = (...args) => spawnSync(process.execPath, args, { encoding: "utf8" });

test("a script run by its plain path is direct", () => scratch(root => {
  const entry = writeEntry(path.join(root, "real"));
  assert.equal(run(entry).stdout.trim(), "direct=true");
}));

test("a script run through a symlinked folder is still direct (this is the macOS /var case)", () => scratch(root => {
  const entry = writeEntry(path.join(root, "real"));
  const link = path.join(root, "link");
  fs.symlinkSync(path.dirname(entry), link, "junction");
  const viaLink = path.join(link, "entry.mjs");
  assert.notEqual(fs.realpathSync(viaLink), viaLink, "the path really goes through a link");
  assert.equal(run(viaLink).stdout.trim(), "direct=true");
}));

test("a relative path and a differently-cased path (Windows) are still direct", () => scratch(root => {
  const entry = writeEntry(path.join(root, "real"));
  const relative = spawnSync(process.execPath, ["entry.mjs"], { encoding: "utf8", cwd: path.dirname(entry) });
  assert.equal(relative.stdout.trim(), "direct=true");
  if (process.platform === "win32") assert.equal(run(entry.toUpperCase().replace(/\.MJS$/, ".mjs")).stdout.trim(), "direct=true");
}));

test("a module that is merely imported by another script is not direct", () => scratch(root => {
  const entry = writeEntry(path.join(root, "real"));
  const importer = path.join(root, "importer.mjs");
  fs.writeFileSync(importer, `import ${JSON.stringify(pathToFileURL(entry).href)};\nconsole.log("imported");\n`);
  const result = run(importer);
  assert.match(result.stdout, /direct=false/);
}));

test("with no script, or a path that does not exist, it is not direct and never throws", () => {
  assert.equal(isDirectExecution(import.meta.url, null), false);
  assert.equal(isDirectExecution(import.meta.url, ""), false);
  assert.equal(isDirectExecution(import.meta.url, path.join(os.tmpdir(), "definitely-not-here-4711.js")), false);
  assert.equal(isDirectExecution(undefined, path.resolve("x.js")), false);
});

test("comparison is by real path, and case-insensitive only on Windows", () => {
  const at = (...parts) => path.resolve(path.sep, ...parts);
  // Everything under a "link" folder really lives under "real".
  const throughLink = { realpath: p => p.replace(/[\\/]link([\\/])/, `${path.sep}real$1`) };
  const url = target => pathToFileURL(target).href;
  assert.equal(isDirectExecution(url(at("real", "a.js")), at("link", "a.js"), { ...throughLink, platform: "linux" }), true, "a link and its target are the same file");
  assert.equal(isDirectExecution(url(at("real", "a.js")), at("link", "b.js"), { ...throughLink, platform: "linux" }), false, "different files are not");
  const identity = { realpath: p => p };
  assert.equal(isDirectExecution(url(at("Tmp", "A.js")), at("tmp", "a.js"), { ...identity, platform: "win32" }), true);
  assert.equal(isDirectExecution(url(at("Tmp", "A.js")), at("tmp", "a.js"), { ...identity, platform: "linux" }), false);
});
