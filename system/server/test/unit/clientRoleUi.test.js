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

test("navigation and privileged surfaces are hidden by default and capability-gated by client logic", () => {
  assert.match(html, /id="admin-nav"\s+hidden/);
  assert.match(html, /id="admin-view"\s+hidden/);
  assert.match(html, /id="admin-nav-button"[^>]+hidden/);
  assert.match(html, /id="assignments-view"\s+hidden/);
  assert.match(app, /adminNavEl\.hidden = !currentOperator/);
  assert.match(app, /adminNavButtonEl\.hidden = !canManageOperations\(\)/);
  assert.match(app, /assignmentCreateFormEl\.hidden = !can\(UI_CAPABILITIES\.MANAGE_ASSIGNMENTS\)/);
  assert.match(app, /nextStatuses\.length && can\(UI_CAPABILITIES\.MANAGE_ASSIGNMENTS\)/);
  assert.match(app, /if \(!canManageOperations\(\)\) return;[\s\S]*currentView = "admin"/);
  assert.match(app, /if \(!can\(UI_CAPABILITIES\.VIEW_ASSIGNMENTS\)\) return;[\s\S]*currentView = "assignments"/);
});

test("fleet management and sensitive audit details use separate capabilities", () => {
  assert.match(app, /canManageOperations\(\) && aiDevices\.length[\s\S]*fetchActiveTasksByDevice\(\)[\s\S]*VIEW_AUDIT[\s\S]*fetchLastActionByDevice\(\)/);
  assert.match(app, /AI-controlled — an operations handoff is required/);
});

test("VA fleet copy and device opening use server-calculated access metadata", () => {
  assert.match(html, /id="fleet-heading"/);
  assert.match(html, /id="detail-access-note"/);
  assert.match(app, /isVa \? "VA Fleet" : "Fleet"/);
  assert.match(app, /if \(!device\?\.canOpen\)[\s\S]*return false;[\s\S]*selectDevice\(device\.id\)/);
  assert.match(app, /d\.assignedToViewer && !isAiMode/);
  assert.doesNotMatch(app, /card\.addEventListener\("click"/);
});

test("live operator profiles replace cached capabilities and scrub privileged views", () => {
  assert.match(app, /msg\.type === "operator_profile"[\s\S]*applyLiveOperatorProfile\(msg\.operator\)/);
  assert.match(app, /function applyLiveOperatorProfile\(profile\)[\s\S]*setOperatorProfile\(profile\)/);
  assert.match(app, /lastDevices = \[\][\s\S]*queueBodyEl\.replaceChildren\(\)[\s\S]*auditBodyEl\.replaceChildren\(\)[\s\S]*usersListEl\.replaceChildren\(\)/);
  for (const functionName of ["refreshPeople", "refreshAssignments", "runAdminCommand", "refreshQueueViewer", "refreshAuditViewer", "refreshUsers"]) {
    const start = app.indexOf(`function ${functionName}`);
    const nextFunction = app.indexOf("\nfunction ", start + 1);
    const body = app.slice(start, nextFunction < 0 ? app.length : nextFunction);
    assert.match(body, /profileRequestActive\(generation/, `${functionName} must reject responses from an older profile`);
  }
});
