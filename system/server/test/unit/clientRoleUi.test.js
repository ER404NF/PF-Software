import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(__dirname, "../../../client");
const html = fs.readFileSync(path.join(clientDir, "index.html"), "utf8");
const app = fs.readFileSync(path.join(clientDir, "app.js"), "utf8");

function htmlIds(source) {
  return new Set([...source.matchAll(/\bid=["']([^"']+)["']/g)].map((m) => m[1]));
}

test("every getElementById reference in app.js exists in index.html", () => {
  const ids = htmlIds(html);
  const refs = [...app.matchAll(/getElementById\(["']([^"']+)["']\)/g)].map((m) => m[1]);
  const missing = [...new Set(refs.filter((id) => !ids.has(id)))];
  assert.deepEqual(missing, []);
});

test("admin/dev surfaces are hidden by default and role-gated by client logic", () => {
  assert.match(html, /id="admin-nav"\s+hidden/);
  assert.match(html, /id="admin-view"\s+hidden/);
  assert.match(app, /adminNavEl\.hidden = !isAdmin\(\)/);
  assert.match(app, /if \(!isAdmin\(\)\) return;[\s\S]*currentView = "admin"/);
});

test("VA fleet rendering does not call admin queue/audit lookups", () => {
  assert.match(app, /isAdmin\(\) && aiDevices\.length[\s\S]*fetchActiveTasksByDevice\(\)[\s\S]*fetchLastActionByDevice\(\)/);
  assert.match(app, /AI-controlled — admin handoff required/);
});
