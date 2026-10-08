import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const context = { window: {}, encodeURIComponent, Promise, JSON, Number, Intl };
// The controller uses the shared proxy and provider names from deviceCardModel.js, which the page loads first.
for (const file of ["deviceCardModel.js", "proxyPoolController.js"]) {
  vm.runInNewContext(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../client", file), "utf8"), context);
}
const { createProxyPoolController } = context.window;

class Element {
  constructor(tag = "div") {
    this.tagName = tag; this.children = []; this.listeners = {}; this.value = ""; this.textContent = "";
    this.hidden = false; this.disabled = false; this.attributes = {}; this.title = "";
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; }
  addEventListener(type, callback) { this.listeners[type] = callback; }
  setAttribute(name, value) { this.attributes[name] = value; }
  querySelector(selector) { return selector === 'button[type="submit"]' ? this.submitButton : null; }
  reset() { this.resetCount = (this.resetCount || 0) + 1; }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture({ requestJson = async url => ({ body: url.includes("providers") ? { providers: [] } : { proxies: [] } }),
  getGeneration = () => 1, requestActive = () => true, can = () => true, onPoolChanged = () => {}, deviceLabel } = {}) {
  const names = ["refreshButton", "createForm", "providerInput", "protocolInput", "hostInput", "portInput",
    "usernameInput", "passwordInput", "countryInput", "labelInput", "testButton", "message", "poolList",
    "poolEmpty", "providerList", "providerEmpty"];
  const elements = Object.fromEntries(names.map(name => [name, new Element()]));
  elements.createForm.submitButton = new Element("button");
  const documentRef = { createElement: tag => new Element(tag) };
  const capabilities = { VIEW_PROXY_POOL: "proxy:view", MANAGE_PROXY: "proxy:manage" };
  const controller = createProxyPoolController({ elements, documentRef, requestJson, getProfileGeneration: getGeneration,
    requestActive, can, capabilities, formatDate: value => value, onPoolChanged, ...(deviceLabel ? { deviceLabel } : {}) });
  return { controller, elements, capabilities };
}

function proxy(overrides = {}) {
  return { id: "px_1", label: "Italy", provider: "Provider", protocol: "socks5", country: "IT",
    leasedToDeviceId: null, ...overrides };
}

test("stale inventory is suppressed and cannot mark the controller loaded", async () => {
  const poolGate = deferred();
  const providerGate = deferred();
  let generation = 1;
  const f = fixture({
    requestJson: url => url.includes("providers") ? providerGate.promise : poolGate.promise,
    getGeneration: () => generation,
    requestActive: requested => requested === generation,
  });
  const pending = f.controller.refresh();
  generation = 2;
  poolGate.resolve({ body: { proxies: [proxy()] } });
  providerGate.resolve({ body: { providers: [{ label: "stale", exits: [] }] } });
  assert.equal(await pending, false);
  assert.equal(f.controller.isLoaded(), false);
  assert.equal(f.controller.getPool().length, 0);
  assert.equal(f.elements.providerList.children.length, 0);
});

test("stale mutation success and failure are silent and controls are restored", async () => {
  for (const outcome of ["success", "failure"]) {
    const gate = deferred();
    let generation = 1;
    const f = fixture({ requestJson: () => gate.promise, getGeneration: () => generation,
      requestActive: requested => requested === generation });
    const button = new Element("button");
    const pending = f.controller.testSavedProxy(proxy(), button);
    generation = 2;
    if (outcome === "success") gate.resolve({ body: { result: { publicIpv4: "198.51.100.1", latencyMs: 4 } } });
    else gate.reject(new Error("private stale failure"));
    assert.equal(await pending, false);
    assert.equal(button.disabled, false);
    assert.equal(f.elements.message.textContent.includes("198.51.100.1"), false);
    assert.equal(f.elements.message.textContent.includes("private stale failure"), false);
  }
});

test("clear removes pool/provider state and password on sign-out or role change", async () => {
  const f = fixture({ requestJson: async url => ({ body: url.includes("providers")
    ? { providers: [{ label: "Provider", exits: [] }] } : { proxies: [proxy()] } }) });
  await f.controller.refresh();
  f.elements.passwordInput.value = "do-not-retain";
  f.controller.clear({ unavailable: true });
  assert.equal(f.controller.getPool().length, 0);
  assert.equal(f.controller.isLoaded(), false);
  assert.equal(f.elements.passwordInput.value, "");
  assert.equal(f.elements.poolList.children.length, 0);
  assert.match(f.elements.poolEmpty.textContent, /not available for this role/);
});

test("pool and provider failures remain independent and retryable", async () => {
  let failPool = true;
  let failProviders = false;
  const f = fixture({ requestJson: async url => {
    if (url.includes("providers")) {
      if (failProviders) throw new Error("provider unavailable");
      return { body: { providers: [{ label: "Provider", exits: [] }] } };
    }
    if (failPool) throw new Error("pool unavailable");
    return { body: { proxies: [proxy()] } };
  } });
  assert.equal(await f.controller.refresh(), true);
  assert.equal(f.controller.isLoaded(), false);
  assert.match(f.elements.poolEmpty.textContent, /pool unavailable/);
  assert.equal(f.elements.providerEmpty.textContent, "Configured providers have not reported any exits.");
  failPool = false;
  failProviders = true;
  assert.equal(await f.controller.refresh(), true);
  assert.equal(f.controller.isLoaded(), true);
  assert.equal(f.controller.getPool().length, 1);
  assert.match(f.elements.providerEmpty.textContent, /provider unavailable/);
});

test("untrusted proxy and provider values are rendered through textContent only", () => {
  const f = fixture();
  f.controller.renderPool([proxy({ label: "<img src=x onerror=alert(1)>", provider: "<script>bad()</script>" })]);
  f.controller.renderProviders([{ label: "<svg onload=bad()>", error: { message: "<b>failure</b>" } }]);
  assert.match(f.elements.poolList.children[0].children[0].children[0].textContent, /<img/);
  assert.match(f.elements.poolList.children[0].children[1].textContent, /<script>/);
  assert.equal(f.elements.providerList.children[0].children[0].textContent, "<svg onload=bad()>");
  assert.equal(f.elements.providerList.children[0].children[1].textContent, "<b>failure</b>");
});

test("unsaved tests clear passwords, restore the button, and can be retried", async () => {
  let attempts = 0;
  const f = fixture({ requestJson: async url => {
    if (url !== "/api/admin/proxies/test") return { body: { proxies: [] } };
    attempts += 1;
    if (attempts === 1) throw new Error("temporary failure");
    return { body: { result: { publicIpv4: "198.51.100.2", latencyMs: 8 } } };
  } });
  f.elements.passwordInput.value = "one-time-secret";
  assert.equal(await f.controller.testUnsavedProxy(), false);
  assert.equal(f.elements.passwordInput.value, "");
  assert.equal(f.elements.testButton.disabled, false);
  assert.equal(f.elements.message.textContent, "temporary failure");
  f.elements.passwordInput.value = "new-one-time-secret";
  assert.equal(await f.controller.testUnsavedProxy(), true);
  assert.equal(f.elements.passwordInput.value, "");
  assert.equal(f.elements.testButton.disabled, false);
});

test("testing with an empty required field points at that field and sends nothing", async () => {
  // Found by the real-click sweep: Test Proxy with an empty form sent the request and answered "Correct the highlighted
  // proxy fields" although nothing was highlighted. Add proxy already pointed at the field; Test Proxy now does the same.
  let requests = 0;
  const f = fixture({ requestJson: async () => { requests += 1; return { body: { result: { publicIpv4: "198.51.100.3", latencyMs: 5 } } }; } });
  const pointedAt = [];
  f.elements.providerInput.checkValidity = () => true;
  f.elements.hostInput.checkValidity = () => false;
  f.elements.hostInput.reportValidity = () => { pointedAt.push("host"); return false; };
  f.elements.portInput.checkValidity = () => false;
  f.elements.portInput.reportValidity = () => { pointedAt.push("port"); return false; };
  assert.equal(await f.controller.testUnsavedProxy(), false);
  assert.deepEqual(pointedAt, ["host"]);
  assert.equal(requests, 0);
  assert.equal(f.elements.testButton.disabled, false);
  f.elements.hostInput.checkValidity = () => true;
  f.elements.portInput.checkValidity = () => true;
  assert.equal(await f.controller.testUnsavedProxy(), true);
  assert.equal(requests, 1);
});

test("capability loss during a mutation suppresses its result", async () => {
  const gate = deferred();
  let mayManage = true;
  const f = fixture({ requestJson: () => gate.promise,
    requestActive: (_generation, capability) => capability === "proxy:manage" ? mayManage : true });
  const button = new Element("button");
  const pending = f.controller.toggleProviderExit({ id: "p", label: "Provider" }, { id: "exit", enabled: true }, button);
  mayManage = false;
  gate.resolve({ body: { exit: { enabled: false } } });
  assert.equal(await pending, false);
  assert.equal(f.elements.message.textContent.includes("disabled"), false);
  assert.equal(button.disabled, false);
});

test("successful pool refresh notifies fleet pickers without duplicating pool state", async () => {
  let changes = 0;
  const expected = proxy();
  const f = fixture({ requestJson: async url => ({ body: url.includes("providers") ? { providers: [] } : { proxies: [expected] } }),
    onPoolChanged: () => { changes += 1; } });
  assert.equal(await f.controller.refresh(), true);
  assert.equal(changes, 1);
  assert.equal(f.controller.getPool()[0].id, expected.id);
});

const textOf = element => [element.textContent, ...element.children.map(textOf)].filter(Boolean).join(" ");
const findAll = (element, predicate) => [element, ...element.children.flatMap(child => findAll(child, predicate))].filter(predicate);

test("an assigned proxy shows the phone's name and a Delete that explains itself in visible text", () => {
  const f = fixture({ deviceLabel: id => (id === "udid-1" ? "iPhone 2" : id) });
  f.controller.renderPool([proxy({ leasedToDeviceId: "udid-1" })]);
  const card = f.elements.poolList.children[0];
  assert.match(textOf(card), /Assigned to iPhone 2/);
  const [row] = findAll(card, el => el.className === "proxy-action-row");
  assert.deepEqual(row.children.map(button => button.textContent), ["Test Proxy", "Delete"]);
  assert.equal(row.children[1].disabled, true);
  const [reason] = findAll(card, el => el.className === "proxy-reason");
  assert.match(reason.textContent, /Can't delete while it is assigned to iPhone 2\. Release it from that phone first\./);
  assert.equal(row.children[1].attributes["aria-describedby"], reason.id);
});

test("an unassigned proxy is Available in a neutral gray, never the red 'inactive' style, and Delete needs no reason", () => {
  const f = fixture();
  f.controller.renderPool([proxy()]);
  const card = f.elements.poolList.children[0];
  const [state] = findAll(card, el => /user-state/.test(el.className || ""));
  assert.equal(state.textContent, "Available");
  assert.match(state.className, / neutral$/);
  assert.doesNotMatch(state.className, /inactive/);
  assert.equal(findAll(card, el => el.className === "proxy-reason").length, 0);
});

test("provider names display the way the provider registry spells them", async () => {
  const f = fixture({ requestJson: async url => ({ body: url.includes("providers")
    ? { providers: [{ id: "oxy", label: "Oxylabs", exits: [] }] } : { proxies: [proxy({ provider: "oxylabs" })] } }) });
  await f.controller.refresh();
  assert.match(textOf(f.elements.poolList.children[0]), /Oxylabs · socks5 · IT/);
});

test("the empty provider list no longer contradicts the proxies that are in use", async () => {
  const f = fixture();
  await f.controller.refresh();
  assert.equal(f.elements.providerEmpty.textContent, "No separate provider inventory is connected. The proxies above are used directly.");
  f.controller.clear();
  assert.equal(f.elements.providerEmpty.textContent, "No separate provider inventory is connected. The proxies above are used directly.");
});

test("results carry a success or error tone for the result line", async () => {
  const f = fixture({ requestJson: async () => ({ body: { result: { publicIpv4: "198.51.100.7", latencyMs: 12 } } }) });
  f.elements.message.dataset = {};
  await f.controller.testSavedProxy(proxy(), new Element("button"));
  assert.equal(f.elements.message.dataset.tone, "success");
  const failing = fixture({ requestJson: async url => { if (url.endsWith("/test")) throw new Error("Proxy refused the connection."); return { body: url.includes("providers") ? { providers: [] } : { proxies: [] } }; } });
  failing.elements.message.dataset = {};
  await failing.controller.testSavedProxy(proxy(), new Element("button"));
  assert.equal(failing.elements.message.dataset.tone, "error");
});
