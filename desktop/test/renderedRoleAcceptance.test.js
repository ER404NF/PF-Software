const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const desktopRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopRoot, "..");

function runElectron({ url, profiles }) {
  return new Promise((resolve, reject) => {
    const electron = require("electron");
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-rendered-electron-"));
    const child = spawn(electron, ["--no-sandbox", "--disable-gpu", "--disable-gpu-compositing",
      path.join(desktopRoot, "scripts", "rendered-role-harness.cjs")], {
      // Chromium's Windows text services may create an empty spelling cache
      // relative to the process cwd. Keep every renderer artifact inside the
      // disposable user-data directory rather than the repository.
      cwd: userData, windowsHide: true, env: { ...process.env, PHONE_FARM_RENDER_URL: url,
        PHONE_FARM_RENDER_PROFILES: Buffer.from(JSON.stringify(profiles)).toString("base64"),
        PHONE_FARM_RENDER_USER_DATA: userData },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("exit", code => {
      fs.rmSync(userData, { recursive: true, force: true });
      if (code !== 0) return reject(new Error(`rendered harness failed (${code}): ${stderr.slice(-1000)} ${stdout.slice(-1000)}`));
      const line = stdout.split(/\r?\n/).find(entry => entry.startsWith("PHONE_FARM_RENDER_RESULT="));
      if (!line) return reject(new Error("rendered harness returned no result"));
      resolve(JSON.parse(line.slice("PHONE_FARM_RENDER_RESULT=".length)));
    });
  });
}

test("rendered role surfaces preserve permissions, keyboard focus, responsive phone geometry, and reduced motion", { timeout: 60000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-rendered-roles-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const deviceConfigPath = path.join(root, "devices.json");
  fs.writeFileSync(deviceConfigPath, JSON.stringify({ devices: [
    { id: "mock-a", label: "Synthetic iPhone", type: "mock" },
  ] }));
  Object.assign(process.env, {
    OPERATORS_CONFIG_PATH: path.join(root, "operators.json"), FILE_STORE_DIR: path.join(root, "storage"),
    SESSION_STORE_DIR: path.join(root, "sessions"), AUDIT_LOG_PATH: path.join(root, "audit.log"),
    QUEUE_STORE_PATH: path.join(root, "queue.json"), ASSIGNMENT_STORE_PATH: path.join(root, "assignments.json"),
    MODEL_SELECTION_STORE_PATH: path.join(root, "models.json"), AUTO_DISCOVER_IOS_DEVICES: "false",
    SESSION_SECRET: "rendered-role-acceptance-secret", PRIVACY_REQUEST_STORE_PATH: path.join(root, "privacy.json"),
    DEVICE_CONFIG_PATH: deviceConfigPath,
  });
  const auth = await import(pathToFileURL(path.join(repoRoot, "system/server/src/authStore.js")).href);
  const { CAPABILITIES, OPERATOR_ROLES, ROLE_CAPABILITIES } = await import(
    pathToFileURL(path.join(repoRoot, "system/server/src/roleCapabilities.js")).href
  );
  const deviceLease = await import(pathToFileURL(path.join(repoRoot, "system/server/src/deviceLease.js")).href);
  const profiles = Object.values(OPERATOR_ROLES).map(role => ({
    name: role,
    username: `render-${role.replaceAll("_", "-")}`,
    role,
    password: `rendered-${role.replaceAll("_", "-")}-password`,
  }));
  assert.deepEqual(profiles.map(profile => profile.role).sort(), Object.values(OPERATOR_ROLES).sort(),
    "the rendered matrix must contain every real operator role exactly once");
  assert.equal(new Set(profiles.map(profile => profile.role)).size, Object.values(OPERATOR_ROLES).length);
  for (const profile of profiles) auth.createOperatorAccount({ username: profile.username, password: profile.password,
    role: profile.role, teamId: profile.role === "manager" ? "render-team" : null, allowedDevices: ["mock-a"] });
  const app = await import(pathToFileURL(path.join(repoRoot, "system/server/src/index.js")).href);
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise(resolve => app.wss.close(resolve)); await new Promise(resolve => app.server.close(resolve)); });
  const results = await runElectron({ url: `http://127.0.0.1:${app.server.address().port}/`, profiles });
  assert.equal(results.length, profiles.length);
  for (const result of results) {
    assert.equal(result.actualRole, result.expectedRole, `${result.name} must render its real account role`);
    assert.deepEqual([...result.capabilities].sort(), [...ROLE_CAPABILITIES[result.expectedRole]].sort());
    assert.equal(result.desktop.overflow <= 1, true, `${result.name} desktop overflow`);
    assert.equal(result.narrow.overflow <= 1, true, `${result.name} narrow overflow`);
    assert.equal(result.focus.visible, true, `${result.name} keyboard focus`);
    assert.equal(result.focus.outline !== "none" || result.focus.boxShadow !== "none", true,
      `${result.name} visible focus indicator: ${JSON.stringify(result.focus)}`);
    assert.equal(result.reducedMotion, true, `${result.name} reduced motion emulation`);
    const capabilities = new Set(ROLE_CAPABILITIES[result.expectedRole]);
    const expectedPanels = {
      "command-console-panel": capabilities.has(CAPABILITIES.MANAGE_QUEUE),
      "queue-panel": capabilities.has(CAPABILITIES.MANAGE_QUEUE),
      "pending-panel": capabilities.has(CAPABILITIES.MANAGE_USERS) || capabilities.has(CAPABILITIES.MANAGE_TEAM_MEMBERS),
      "users-panel": capabilities.has(CAPABILITIES.MANAGE_USERS) || capabilities.has(CAPABILITIES.MANAGE_TEAM_MEMBERS),
      "sites-panel": capabilities.has(CAPABILITIES.MANAGE_SITES),
      "proxy-pool-panel": capabilities.has(CAPABILITIES.VIEW_PROXY_POOL),
      "audit-panel": capabilities.has(CAPABILITIES.VIEW_AUDIT),
    };
    for (const [panel, permitted] of Object.entries(expectedPanels)) {
      assert.equal(result.desktop.permitted.includes(panel), permitted, `${result.name} ${panel} visibility`);
      assert.equal(result.desktop.forbidden.includes(panel), !permitted, `${result.name} ${panel} denial`);
    }
    const controlsDevice = capabilities.has(CAPABILITIES.CONTROL_DEVICE);
    assert.equal(result.desktop.canControl, controlsDevice, `${result.name} input ownership`);
    assert.equal(result.desktop.hasControlButton, true, `${result.name} gets an explicit control/read-only state`);
    assert.equal(result.desktop.controlDisabled, !controlsDevice, `${result.name} disabled control state`);
    if (controlsDevice) {
      assert.equal(result.detail.fullScreenControl, true);
      assert.equal(result.detail.alertRole, "alert");
      assert.equal(result.detail.inputDisabled, false, `${result.name} owns human-mode input`);
      assert.equal(result.fullscreen.entered || result.fullscreen.unsupported === true, true);
      if (result.fullscreen.entered) assert.equal(result.fullscreen.exited, true);
    }
    assert.notEqual(result.dark.color, result.dark.background);
  }

  deviceLease.switchToAI("mock-a");
  const manager = profiles.find(profile => profile.role === OPERATOR_ROLES.MANAGER);
  const [aiControlled] = await runElectron({ url: `http://127.0.0.1:${app.server.address().port}/`,
    profiles: [{ ...manager, name: "manager-ai-controlled", scenario: "ai-controlled" }] });
  assert.equal(aiControlled.actualRole, OPERATOR_ROLES.MANAGER);
  assert.equal(aiControlled.desktop.canControl, false, "AI-controlled state cannot grant human input");
  assert.equal(aiControlled.desktop.canWatch, true, "manager can open the AI-controlled device read-only");
  assert.equal(aiControlled.detail.inputDisabled, true, "AI-controlled monitoring keeps device input disabled");
  deviceLease.emergencyStop("mock-a");
});
