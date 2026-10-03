import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const context = { window: {} };
vm.runInNewContext(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)),
  "../../../client/peopleAssignmentsController.js"), "utf8"), context);
const { createPeopleAssignmentsController } = context.window;

class Element {
  constructor(tag = "div") { this.tagName = tag; this.children = []; this.listeners = {}; this.value = "";
    this.textContent = ""; this.hidden = false; this.disabled = false; this.checked = false; this.attributes = {}; }
  append(...children) { this.children.push(...children); }
  prepend(...children) { this.children.unshift(...children); }
  replaceChildren(...children) { this.children = [...children]; }
  addEventListener(type, callback) { this.listeners[type] = callback; }
  setAttribute(name, value) { this.attributes[name] = value; }
  querySelector(selector) { return selector === 'button[type="submit"]' ? this.submitButton : null; }
  querySelectorAll() { return []; }
  cloneNode() { const copy = new Element(this.tagName); Object.assign(copy, this); copy.children = [...this.children]; return copy; }
  get options() { return this.children; }
  get childElementCount() { return this.children.filter(child => typeof child === "object").length; }
}

class FakeOption extends Element {
  constructor(text, value, _defaultSelected = false, selected = false) {
    super("option"); this.textContent = text; this.value = value; this.selected = selected;
  }
}

function fixture({ requestJson, getGeneration = () => 1, requestActive = () => true,
  getCurrentOperator = () => ({ allowedDevices: null }), getDevices = () => [] } = {}) {
  const names = ["peopleList", "peopleSummary", "peopleError", "peopleRefreshButton", "assignmentsRefreshButton",
    "assignmentCreateForm", "assignmentAssignee", "assignmentDevice", "assignmentAccount", "assignmentStart",
    "assignmentEnd", "assignmentRecurrence", "assignmentExclusive", "assignmentInstructions", "assignmentsMessage",
    "assignmentsList", "assignmentsEmpty"];
  const elements = Object.fromEntries(names.map(name => [name, new Element()]));
  elements.assignmentCreateForm.submitButton = new Element("button");
  const documentRef = { createElement: tag => new Element(tag), createTextNode: text => ({ textContent: text }) };
  const controller = createPeopleAssignmentsController({
    elements, documentRef, windowRef: { confirm: () => true }, OptionCtor: FakeOption,
    requestJson, getProfileGeneration: getGeneration, requestActive, can: () => false,
    capabilities: { VIEW_PEOPLE: "people:view", VIEW_ASSIGNMENTS: "assignments:view",
      MANAGE_ASSIGNMENTS: "assignments:manage" },
    getCurrentOperator, getDevices, displayRole: role => role, formatLastSeen: () => "Active now",
    formatDate: value => value, showSurfaceMessage: (element, message) => { element.textContent = message; },
  });
  return { controller, elements };
}

test("stale people and assignment responses cannot repopulate a changed role", async () => {
  let resolvePeople;
  let resolveAssignments;
  let generation = 1;
  const requests = [new Promise(resolve => { resolvePeople = resolve; }), new Promise(resolve => { resolveAssignments = resolve; })];
  const f = fixture({ requestJson: () => requests.shift(), getGeneration: () => generation,
    requestActive: requested => requested === generation });
  const people = f.controller.refreshPeople();
  generation = 2;
  resolvePeople({ body: { people: [{ username: "stale", role: "admin", online: true }] } });
  assert.equal(await people, false);
  assert.equal(f.elements.peopleList.children.length, 0);
  const assignments = f.controller.refreshAssignments();
  generation = 3;
  resolveAssignments({ body: { assignments: [{ id: "stale" }] } });
  assert.equal(await assignments, false);
  assert.equal(f.elements.assignmentsList.children.length, 0);
});

test("unavailable data reports the current error beside its initiating surface", async () => {
  const f = fixture({ requestJson: async url => { throw new Error(url.includes("people") ? "People unavailable" : "Assignments unavailable"); } });
  assert.equal(await f.controller.refreshPeople(), false);
  assert.equal(f.elements.peopleError.textContent, "People unavailable");
  assert.equal(await f.controller.refreshAssignments(), false);
  assert.equal(f.elements.assignmentsMessage.textContent, "Assignments unavailable");
});

test("assignment choices follow the current role grant instead of cached device access", () => {
  let operator = { allowedDevices: ["a"] };
  const f = fixture({ requestJson: async () => ({ body: {} }), getCurrentOperator: () => operator,
    getDevices: () => [{ id: "a", label: "A" }, { id: "b", label: "B" }] });
  f.controller.renderPeople([
    { username: "eligible", role: "va", online: false, canAssign: true },
    { username: "denied", role: "va", online: false, canAssign: false },
  ]);
  f.controller.populateAssignmentForm();
  assert.deepEqual(f.elements.assignmentAssignee.options.map(option => option.value), ["eligible"]);
  assert.deepEqual(f.elements.assignmentDevice.options.map(option => option.value), ["", "a"]);
  operator = { allowedDevices: ["b"] };
  f.controller.populateAssignmentForm();
  assert.deepEqual(f.elements.assignmentDevice.options.map(option => option.value), ["", "b"]);
});

test("assignment mutation failures preserve the failure, expose retry, and release pending controls", async () => {
  const f = fixture({ requestJson: async () => { throw new Error("Write failed"); } });
  const card = new Element("article");
  const control = new Element("button");
  card.querySelectorAll = () => [control];
  const message = new Element("p");
  let failureCallback = 0;
  assert.equal(await f.controller.updateAssignment("work", { status: "completed" }, {
    card, messageEl: message, onFailure: () => { failureCallback += 1; },
  }), false);
  assert.equal(failureCallback, 1);
  assert.equal(card.attributes["aria-busy"], "false");
  assert.equal(control.disabled, false);
  assert.match(message.children[0].textContent, /Write failed.*not changed/);
  assert.equal(message.children[1].textContent, "Retry");
});
