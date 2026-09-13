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
  assert.match(app, /const mayManage = can\(UI_CAPABILITIES\.MANAGE_ASSIGNMENTS\)/);
  assert.match(app, /mayProgressOwnVaTask = currentOperator\?\.role === "va" && assignment\.assignee === currentOperator\.username/);
  assert.match(app, /nextStatuses\.filter\(value => mayManage \|\| value !== "cancelled"\)/);
  assert.match(app, /if \(!canManageOperations\(\)\) return;[\s\S]*currentView = "admin"/);
  assert.match(app, /if \(!can\(UI_CAPABILITIES\.VIEW_ASSIGNMENTS\)\) return;[\s\S]*currentView = "assignments"/);
});

test("fleet management and sensitive audit details use separate capabilities", () => {
  assert.match(app, /canManageOperations\(\) && aiDevices\.length[\s\S]*fetchActiveTasksByDevice\(\)[\s\S]*VIEW_AUDIT[\s\S]*fetchLastActionByDevice\(\)/);
  assert.match(app, /This phone is currently controlled by AI\. Contact your manager or use another assigned phone\./);
});

test("authorized fleet cards expose a Human and AI controller switch", () => {
  const css = fs.readFileSync(path.join(clientDir, "style.css"), "utf8");
  assert.match(app, /function buildControllerModeSwitch\(device, statusEl = null\)/);
  assert.match(app, /input\.setAttribute\("role", "switch"\)/);
  assert.match(app, /runAdminCommand\(`\/mode \$\{requestedAi \? "ai" : "human"\} \$\{device\.id\}`/);
  assert.match(app, /function buildFleetAiControls\(device, task, \{ statusEl = null \} = \{\}\)[\s\S]*if \(!can\(UI_CAPABILITIES\.MANAGE_AI_CONTROLLER\)\) return null;[\s\S]*buildControllerModeSwitch\(device, statusEl\)/);
  assert.match(css, /\.controller-mode-switch[\s\S]*\.controller-mode-track/);
});

test("VA fleet copy and device opening use server-calculated access metadata", () => {
  assert.match(html, /id="fleet-heading"/);
  assert.match(html, /id="detail-access-note"/);
  assert.match(app, /isVa \? "VA Fleet" : "Fleet"/);
  assert.match(app, /if \(!device\?\.canOpen\)[\s\S]*return false;[\s\S]*selectDevice\(device\.id\)/);
  assert.match(app, /function phoneStatePresentation\(device\)/);
  assert.match(app, /\["Available to you", devices\.filter\(device => device\.canOpen\)\.length\]/);
  assert.doesNotMatch(app, /card\.addEventListener\("click"/);
});

test("live watch UI uses server-calculated permission and renders read-only controls", () => {
  assert.match(html, /id="watch-controls"\s+hidden/);
  assert.match(html, /id="ai-chat-panel"\s+hidden/);
  assert.match(app, /if \(d\.canWatch\)[\s\S]*requestDeviceWatch\(d\)/);
  assert.match(app, /isAiMode \? "Open AI workspace"/);
  assert.match(app, /safeSend\(\{ type: "watch_device", deviceId: device\.id \}, \{ statusEl: detailMessageEl \}\)/);
  assert.match(app, /Phone controls and files are unavailable/);
  assert.match(app, /if \(!currentDeviceId \|\| pendingDeviceId \|\| busy\) return/);
});

test("AI workspace commands remain device-scoped and never enable screen input", () => {
  assert.match(html, /Screen read-only/);
  assert.match(html, /Direct screen input stays disabled while AI is in control/);
  assert.match(app, /function runAiWorkspaceCommand\(rawText\)/);
  assert.match(app, /text\.startsWith\("\/cresearch "\)/);
  assert.match(app, /runAdminCommand\(command, \{ deviceId, statusEl: detailMessageEl \}\)/);
  assert.match(app, /\["pause", `\/pause \$\{deviceId\}`\]/);
  assert.match(app, /\["human", `\/mode human \$\{deviceId\}`\]/);
  assert.match(app, /Commands are limited to this phone/);
  assert.doesNotMatch(app, /safeSend\(\{ type: "(?:tap|swipe|home|type_text)"[^}]*aiChat/);
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

test("the shared role UI uses a monochrome shell with explicit traffic-light status indicators", () => {
  const css = fs.readFileSync(path.join(clientDir, "style.css"), "utf8");
  assert.match(css, /--font-ui:\s*"Segoe UI Variable Text", Aptos/);
  assert.match(css, /body\s*\{[^}]*font-family:\s*var\(--font-ui\)/);
  assert.match(css, /--ink:\s*#111111/);
  assert.match(css, /--surface:\s*#ffffff/);
  assert.match(css, /--online:\s*#00c853/);
  assert.match(css, /--offline:\s*#ff1744/);
  assert.match(css, /--loading:\s*#ffd600/);
  assert.match(css, /\.device-card\.idle \.status-dot,[\s\S]*\.device-card\.in-use \.status-dot\s*\{\s*background: var\(--online\)/);
  assert.match(css, /\.device-card\.warning \.status-dot\s*\{\s*background: var\(--loading\)/);
  assert.match(css, /\.device-card\.offline \.status-dot\s*\{\s*background: var\(--offline\)/);
  assert.match(css, /\.presence-dot\s*\{[^}]*background: var\(--offline\)/);
  assert.match(css, /\.person-row\.online \.presence-dot\s*\{\s*background: var\(--online\)/);
  assert.match(html, /id="connection-status" class="connection-state loading"[^>]*>Connecting</);
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/);
});

test("fleet guidance does not promise device control to read-only roles", () => {
  assert.match(app, /can\(UI_CAPABILITIES\.CONTROL_DEVICE\)[\s\S]*View fleet status and open available phones\.[\s\S]*View fleet status and device availability\./);
});

test("role and error-handling audit controls are explicit and recoverable", () => {
  assert.match(app, /content_creator: "Content Creator"/);
  assert.match(app, /class RequestFailure extends Error/);
  assert.match(app, /Phone Farm could not be reached\. Your change was not confirmed/);
  assert.match(app, /LOGOUT_PENDING_KEY = "phone-farm-logout-pending"/);
  assert.match(app, /server could not confirm session revocation/);
  assert.match(html, /id="logout-retry-button"/);
  assert.match(html, /id="detail-message" role="alert"/);
  assert.match(app, /Cancel this assignment for \$\{assignment\.assignee\}/);
  assert.match(app, /Save assignee/);
  assert.match(app, /Delete “\$\{name\}” from \$\{phone\}\? This cannot be undone\./);
  assert.match(app, /Sign out all sessions for \$\{user\.username\}/);
  assert.match(app, /Reset two-factor authentication for \$\{user\.username\}/);
  assert.match(app, /Reject \$\{user\.username\}\?/);
  assert.match(app, /No tasks are currently in the queue\./);
  assert.match(app, /markPresenceUnavailable\(\)/);
  assert.match(html, /id="release-button"[^>]*>Release device<\/button>[\s\S]*id="detail-access-note"/);
  assert.match(html, /id="type-form"[\s\S]*button type="submit" disabled>Send/);
  assert.match(html, /id="upload-form"[\s\S]*button type="submit" disabled>Upload/);
  const css = fs.readFileSync(path.join(clientDir, "style.css"), "utf8");
  assert.match(css, /#device-control-bar\s*\{[\s\S]*position: sticky/);
  assert.match(css, /max-height: clamp\(240px, calc\(100vh - 390px\), 620px\)/);
});

test("fleet connectors stop at the device group and proxy switching stays capability-gated", () => {
  const css = fs.readFileSync(path.join(clientDir, "style.css"), "utf8");
  assert.match(app, /grid\.style\.setProperty\("--fleet-width"/);
  assert.match(css, /\.fleet-grid\s*\{[\s\S]*width:\s*min\(100%, var\(--fleet-width, 290px\)\)/);
  assert.match(css, /\.fleet-grid::before\s*\{[\s\S]*left:\s*145px;[\s\S]*right:\s*145px/);
  assert.match(css, /\.fleet-group-heading::after\s*\{[\s\S]*height:\s*16px/);
  assert.match(app, /MANAGE_PROXY:\s*"proxy:manage"/);
  assert.match(app, /can\(UI_CAPABILITIES\.MANAGE_PROXY\)\s*&&\s*isProxyEgress/);
  assert.match(app, /\/api\/admin\/devices\/\$\{encodeURIComponent\(device\.id\)\}\/proxy/);
});
