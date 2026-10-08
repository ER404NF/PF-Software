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

// Found by the real-click sweep: the live connection pushes the phone list about every ten seconds, and each push
// rebuilt the whole Assignments list, closing "Manage assignment" and wiping any time the person was typing.
const sampleAssignment = overrides => ({ id: "a1", instructions: "Check posts", status: "assigned", assignee: "demo-admin",
  createdBy: "demo-admin", recurrence: "once", history: [{ at: "2026-10-07T10:00:00Z", actor: "demo-admin", action: "created" }], ...overrides });

test("drawing the same assignments again keeps the cards the person is working in", () => {
  const f = fixture({ requestJson: async () => ({ body: {} }) });
  f.controller.renderAssignments([sampleAssignment()]);
  const first = f.elements.assignmentsList.children[0];
  assert.ok(first, "a card was drawn");
  f.controller.renderAssignments([sampleAssignment()]);
  assert.equal(f.elements.assignmentsList.children[0], first, "the very same card, not a rebuilt copy");
});

test("when an assignment really changes the list is drawn again", () => {
  const f = fixture({ requestJson: async () => ({ body: {} }) });
  f.controller.renderAssignments([sampleAssignment()]);
  const first = f.elements.assignmentsList.children[0];
  f.controller.renderAssignments([sampleAssignment({ status: "in_progress" })]);
  assert.notEqual(f.elements.assignmentsList.children[0], first);
  f.controller.renderAssignments([]);
  assert.equal(f.elements.assignmentsList.children.length, 0, "an empty list clears the page");
  assert.equal(f.elements.assignmentsEmpty.hidden, false);
});

test("a change to who can be chosen as assignee draws the list again", () => {
  const f = fixture({ requestJson: async () => ({ body: {} }) });
  f.controller.renderAssignments([sampleAssignment()]);
  const first = f.elements.assignmentsList.children[0];
  f.elements.assignmentAssignee.append(new FakeOption("New person", "new-person"));
  f.controller.renderAssignments([sampleAssignment()]);
  assert.notEqual(f.elements.assignmentsList.children[0], first);
});

// Found by the real-click sweep: pressing Update schedule, Save assignee, Start or Complete gave no confirmation at all
// (the card is redrawn and the only trace was a changed badge). Each success now says what happened, on that card.
test("a successful change says what happened on the assignment's card, and the words survive the redraw", async () => {
  const f = fixture({ requestJson: async () => ({ body: { assignments: [] } }) });
  f.controller.renderAssignments([sampleAssignment()]);
  const card = f.elements.assignmentsList.children[0];
  const cardMessage = card.children[2];
  await f.controller.updateAssignment("a1", { status: "in_progress" }, { card, messageEl: cardMessage });
  assert.equal(cardMessage.textContent, "Started.", "said on the card the person pressed");
  f.controller.renderAssignments([sampleAssignment({ status: "in_progress" })]); // the redraw that follows a real change
  const redrawn = f.elements.assignmentsList.children[0];
  assert.notEqual(redrawn, card);
  assert.equal(redrawn.children[2].textContent, "Started.", "and on the redrawn card");
});

test("each kind of change has its own plain confirmation", async () => {
  const cases = [
    [{ status: "completed" }, "Marked complete."],
    [{ status: "cancelled" }, "Cancelled."],
    [{ assignee: "sam" }, "Assignee changed to sam."],
    [{ startAt: null, endAt: null, exclusive: true }, "Schedule saved."],
  ];
  for (const [change, expected] of cases) {
    const f = fixture({ requestJson: async () => ({ body: { assignments: [] } }) });
    f.controller.renderAssignments([sampleAssignment()]);
    const card = f.elements.assignmentsList.children[0];
    await f.controller.updateAssignment("a1", change, { card, messageEl: card.children[2] });
    assert.equal(card.children[2].textContent, expected, JSON.stringify(change));
  }
});

test("a failed change still shows its error, and no false confirmation", async () => {
  const f = fixture({ requestJson: async () => { throw new Error("That assignment no longer exists."); } });
  f.controller.renderAssignments([sampleAssignment()]);
  const card = f.elements.assignmentsList.children[0];
  await f.controller.updateAssignment("a1", { status: "in_progress" }, { card, messageEl: card.children[2] });
  assert.equal(card.children[2].children[0].textContent, "That assignment no longer exists. The assignment was not changed. ");
  assert.notEqual(card.children[2].textContent, "Started.");
});
