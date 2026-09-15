import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import vm from "vm";

const code = fs.readFileSync(new URL("../../../client/research.js", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../../../client/index.html", import.meta.url), "utf8");
function harness(fetch) {
  class Element {
    constructor(tag = "div") { this.tag = tag; this.children = []; this.listeners = {}; this.hidden = true; this.value = ""; this.textContent = ""; }
    append(el) { this.children.push(el); }
    replaceChildren() { this.children = []; }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    setAttribute() {}
  }
  const elements = new Map();
  const events = {};
  const browserWindow = {
    addEventListener: (type, fn) => { events[type] = fn; },
    phoneFarmRequestJson: async (url, options) => {
      const response = await fetch(url, options);
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error || `Request failed (${response.status})`);
      return { body, response };
    },
  };
  const context = vm.createContext({ fetch, URL, document: {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id);
    }, createElement: (tag) => new Element(tag),
  }, window: browserWindow });
  vm.runInContext(code, context);
  return { elements, events, context };
}

test("research UI references real HTML elements", () => {
  for (const [, id] of code.matchAll(/getElementById\("([^"]+)"\)/g)) assert.ok(html.includes(`id="${id}"`), id);
});

test("a late account response cannot repopulate research after logout or operator switch", async () => {
  let resolve;
  const h = harness(() => new Promise((r) => { resolve = r; }));
  const opening = h.elements.get("research-toggle").listeners.click();
  h.events["operator-profile-changed"]();
  resolve({ ok: true, json: async () => ({ accounts: [{ id: "private", workspaceId: "client-a" }] }) });
  await opening;
  assert.equal(h.elements.get("research-panel").hidden, true);
  assert.equal(h.elements.get("research-account").children.length, 0);
});

test("research renders untrusted text literally and omits executable links", () => {
  const h = harness();
  vm.runInContext(`renderResearchRun({id:"run-1", platform:"x", createdAt:"today", overview:"<script>bad()</script>",
    candidates:[{id:"c", source_handle:"<img onerror=bad()>", url:"javascript:bad()", status:"pending"}]}, "account", 0)`, h.context);
  const run = h.elements.get("research-results").children[0];
  assert.equal(run.children[1].textContent, "<script>bad()</script>");
  const card = run.children[2];
  assert.equal(card.children[0].textContent, "<img onerror=bad()>");
  assert.equal(card.children.some((el) => el.tag === "a"), false);
});

test("research renders only same-account server evidence references as links", () => {
  const h = harness();
  vm.runInContext(`renderResearchRun({id:"run-1", platform:"x", createdAt:"today", overview:"safe",
    candidates:[{id:"c", status:"pending", evidence_refs:[
      "/api/research/account/evidence/evidence-1234abcd-abcd-abcd-abcd-123456789abc.png",
      "/api/research/other/evidence/evidence-1234abcd-abcd-abcd-abcd-123456789abc.png",
      "javascript:bad()"]}]}, "account", 0)`, h.context);
  const card = h.elements.get("research-results").children[0].children[2];
  const evidence = card.children.find(child => child.tag === "p" && child.children.some(item => item.tag === "a"));
  const links = evidence.children.filter(child => child.tag === "a");
  assert.equal(links.length, 1);
  assert.equal(links[0].href, "/api/research/account/evidence/evidence-1234abcd-abcd-abcd-abcd-123456789abc.png");
  assert.equal(links[0].rel, "noopener noreferrer");
});

test("refresh before account discovery finishes does not cancel the account response", async () => {
  let resolve;
  const h = harness(() => new Promise((r) => { resolve = r; }));
  const opening = h.elements.get("research-toggle").listeners.click();
  await h.elements.get("research-refresh").listeners.click();
  resolve({ ok: true, json: async () => ({ accounts: [] }) });
  await opening;
  assert.match(h.elements.get("research-message").textContent, /No research accounts assigned/);
});

test("sign-out clears research immediately even before the logout request finishes", () => {
  const h = harness();
  h.elements.get("research-panel").hidden = false;
  h.elements.get("research-message").textContent = "private";
  h.elements.get("logout-button").listeners.click();
  assert.equal(h.elements.get("research-panel").hidden, true);
  assert.equal(h.elements.get("research-message").textContent, "");
});
