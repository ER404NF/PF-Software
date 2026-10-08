const test = require("node:test");
const assert = require("node:assert/strict");
const { buildMenuTemplate } = require("../menu.js");

const handlers = {
  setLaunchAtLogin() {}, setProxyRouting() {}, setAutomation() {}, copyDiagnostics() {}, showLogFolder() {}, moveAsideDamagedRecords() {},
};
const build = overrides => buildMenuTemplate({ isMac: true, isPackaged: true, config: { mode: "host" }, launchAtLogin: true, handlers, ...overrides });
const menuLabeled = (template, label) => template.find(item => item.label === label);
const flat = items => items.flatMap(item => [item, ...(item.submenu ? flat(item.submenu) : [])]);

test("an installed Bodun has no Reload, Force Reload or developer tools", () => {
  const roles = flat(build({ isPackaged: true })).map(item => item.role);
  for (const role of ["reload", "forceReload", "toggleDevTools"]) assert.ok(!roles.includes(role), role);
});

test("a development run still has them", () => {
  const roles = flat(build({ isPackaged: false })).map(item => item.role);
  for (const role of ["reload", "forceReload", "toggleDevTools"]) assert.ok(roles.includes(role), role);
});

test("there is exactly one Toggle Full Screen", () => {
  for (const isPackaged of [true, false]) {
    assert.equal(flat(build({ isPackaged })).filter(item => item.role === "togglefullscreen").length, 1);
  }
});

test("the settings are in the Bodun menu and none are left in Help", () => {
  const template = build({});
  const settings = menuLabeled(template, "Bodun").submenu.filter(item => item.label).map(item => item.label);
  assert.deepEqual(settings, [
    "Start Bodun When This Mac Starts",
    "Enable Proxy Routing on This Mac (restart required)",
    "Automatic Network Enrollment (restart required)",
    "Automatic Internet Sharing (restart required)",
    "Move Aside Damaged Process Records…",
  ]);
  assert.deepEqual(menuLabeled(template, "Help").submenu.map(item => item.label), ["Copy Diagnostics", "Show Log Folder"]);
});

test("the automation switches start off, and need routing switched on before they can be used", () => {
  const find = (template, text) => menuLabeled(template, "Bodun").submenu.find(item => (item.label || "").startsWith(text));
  const off = build({ config: { mode: "host" } });
  assert.equal(find(off, "Automatic Network Enrollment").checked, false);
  assert.equal(find(off, "Automatic Network Enrollment").enabled, false);
  const on = build({ config: { mode: "host", autoRouteProxyTunnels: true, autoNetworkEnrollment: true } });
  assert.equal(find(on, "Automatic Network Enrollment").checked, true);
  assert.equal(find(on, "Automatic Network Enrollment").enabled, true);
  assert.equal(find(on, "Automatic Internet Sharing").checked, false);
});

test("a workstation that is not a host has no routing or automation switches", () => {
  const labels = menuLabeled(build({ config: { mode: "operator" } }), "Bodun").submenu.map(item => item.label).filter(Boolean);
  assert.deepEqual(labels, ["Start Bodun When This Mac Starts"]);
});

test("start at login cannot be changed from a development run", () => {
  const item = menuLabeled(build({ isPackaged: false }), "Bodun").submenu.find(entry => entry.label === "Start Bodun When This Mac Starts");
  assert.equal(item.enabled, false);
});

test("each switch calls the matching handler with the new value", () => {
  const calls = [];
  const template = build({
    config: { mode: "host", autoRouteProxyTunnels: true },
    handlers: {
      ...handlers,
      setLaunchAtLogin: value => calls.push(["login", value]),
      setProxyRouting: value => calls.push(["routing", value]),
      setAutomation: (key, value) => calls.push([key, value]),
    },
  });
  const items = menuLabeled(template, "Bodun").submenu.filter(item => item.label);
  items[0].click({ checked: false });
  items[1].click({ checked: false });
  items[2].click({ checked: true });
  items[3].click({ checked: true });
  assert.deepEqual(calls, [["login", false], ["routing", false], ["autoNetworkEnrollment", true], ["autoInternetSharing", true]]);
});

test("the menu labels are plain words, with no file names or code", () => {
  const labels = flat(build({})).map(item => item.label).filter(Boolean);
  for (const label of labels) assert.doesNotMatch(label, /[A-Z_]{5,}|\.js|\/|\(\)/, label);
});

test("the menu module ships inside the installer", () => {
  const pkg = require("../package.json");
  assert.ok(pkg.build.files.includes("menu.js"));
});

test("Move Aside Damaged Process Records is in the Bodun menu for a host and for a site, not for a workstation, and calls its handler", () => {
  const find = template => menuLabeled(template, "Bodun").submenu.find(item => item.label === "Move Aside Damaged Process Records…");
  assert.ok(find(build({ config: { mode: "host" } })));
  assert.ok(find(build({ config: { mode: "site" } })));
  assert.equal(find(build({ config: { mode: "operator" } })), undefined);
  assert.equal(find(build({ config: { mode: "client" } })), undefined);
  let calls = 0;
  const item = find(build({ config: { mode: "host" }, handlers: { ...handlers, moveAsideDamagedRecords: () => { calls += 1; } } }));
  item.click();
  assert.equal(calls, 1);
  assert.equal(item.enabled === false, false, "it is always available (it refuses by itself, with a reason, while the server runs)");
});

test("the menu action is not left in Help and sits after the switches", () => {
  const labels = menuLabeled(build({}), "Bodun").submenu.map(item => item.label).filter(Boolean);
  assert.equal(labels.at(-1), "Move Aside Damaged Process Records…");
  assert.ok(!menuLabeled(build({}), "Help").submenu.some(item => /Damaged/.test(item.label)));
});
