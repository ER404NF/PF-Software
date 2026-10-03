import { test } from "node:test";
import assert from "node:assert/strict";
import { createFilePushSkill, FILE_PUSH_STATES } from "../../src/platformSkills/filePushSkill.js";

// A fixture device whose accessibility tree reacts to taps/typed text, the
// same convention platformActions.test.js's PostScreen fixture already uses
// for every other skill in this project. Phases: springboard -> address_bar
// -> downloading -> downloaded (or -> error, forced via forceError()).
class SafariFixture {
  // autoCompleteDownloadAfterTicks simulates a real download that finishes
  // after some real elapsed time: each observation taken while "downloading"
  // counts a tick, and after enough of them the phase moves on to
  // "downloaded" by itself — set to null/Infinity to simulate a download
  // that never completes (for TIMED_OUT tests).
  constructor({ instantDownload = false, requireDownloadConfirmation = false, autoCompleteDownloadAfterTicks = 2 } = {}) {
    this.id = "fixture-iphone";
    this.phase = "springboard";
    this.instantDownload = instantDownload;
    this.requireDownloadConfirmation = requireDownloadConfirmation;
    this.autoCompleteDownloadAfterTicks = autoCompleteDownloadAfterTicks;
    this.downloadTicks = 0;
    this.typed = [];
    this.taps = [];
  }

  tree() {
    if (this.phase === "downloading") {
      this.downloadTicks += 1;
      if (this.autoCompleteDownloadAfterTicks != null && this.downloadTicks >= this.autoCompleteDownloadAfterTicks) {
        this.phase = "downloaded";
      }
    }
    if (this.phase === "springboard") {
      return {
        screen: "home",
        viewport: { x: 0, y: 0, width: 100, height: 200 },
        elements: [
          { type: "staticText", label: "springboard", frame: { x: 0, y: 0, width: 100, height: 10 } },
          { type: "icon", label: "Safari", frame: { x: 10, y: 100, width: 20, height: 20 } },
        ],
      };
    }
    if (this.phase === "address_bar") {
      return {
        screen: "safari",
        viewport: { x: 0, y: 0, width: 100, height: 200 },
        elements: [
          { type: "textField", label: "Search or enter website name", frame: { x: 5, y: 5, width: 90, height: 10 } },
        ],
      };
    }
    if (this.phase === "download_confirmation") {
      return {
        screen: "safari",
        viewport: { x: 0, y: 0, width: 100, height: 200 },
        elements: [
          { type: "staticText", label: "Do you want to download this file?", frame: { x: 5, y: 70, width: 90, height: 20 } },
          { type: "button", label: "Download", frame: { x: 55, y: 110, width: 35, height: 20 } },
        ],
      };
    }
    if (this.phase === "downloading") {
      return {
        screen: "safari",
        viewport: { x: 0, y: 0, width: 100, height: 200 },
        elements: [{ type: "staticText", label: "Downloading", frame: { x: 5, y: 5, width: 90, height: 10 } }],
      };
    }
    if (this.phase === "downloaded") {
      return {
        screen: "safari",
        viewport: { x: 0, y: 0, width: 100, height: 200 },
        elements: [{ type: "staticText", label: "Download Complete", frame: { x: 5, y: 5, width: 90, height: 10 } }],
      };
    }
    return {
      screen: "safari",
      viewport: { x: 0, y: 0, width: 100, height: 200 },
      elements: [{ type: "staticText", label: "Safari cannot open the page", frame: { x: 5, y: 5, width: 90, height: 10 } }],
    };
  }

  observe() { return { source: "ui_tree", ui_tree: this.tree() }; }
  async getUiTree() { return this.tree(); }

  async tap(x, y) {
    this.taps.push([x, y]);
    if (this.phase === "springboard" && x >= 0.1 && x <= 0.3 && y >= 0.5 && y <= 0.6) this.phase = "address_bar";
    if (this.phase === "download_confirmation" && x >= 0.55 && x <= 0.9 && y >= 0.55 && y <= 0.65) {
      this.phase = this.instantDownload ? "downloaded" : "downloading";
    }
  }

  async typeText(text) {
    this.typed.push(text);
    if (this.phase === "address_bar" && text.endsWith("\n")) {
      this.phase = this.requireDownloadConfirmation
        ? "download_confirmation"
        : (this.instantDownload ? "downloaded" : "downloading");
    }
  }

  async pressHome() { this.phase = "springboard"; }
  finishDownload() { this.phase = "downloaded"; }
  forceError() { this.phase = "error"; }
}

test("detectState recognizes springboard, address bar, downloading, downloaded, and error — not just a few happy-path phases", async () => {
  const skill = createFilePushSkill();
  const fixture = new SafariFixture();
  assert.equal(await skill.detectState(fixture.observe()), FILE_PUSH_STATES.SPRINGBOARD);
  fixture.phase = "address_bar";
  assert.equal(await skill.detectState(fixture.observe()), FILE_PUSH_STATES.ADDRESS_BAR);
  fixture.phase = "downloading";
  assert.equal(await skill.detectState(fixture.observe()), FILE_PUSH_STATES.DOWNLOAD_IN_PROGRESS);
  fixture.phase = "downloaded";
  assert.equal(await skill.detectState(fixture.observe()), FILE_PUSH_STATES.DOWNLOAD_COMPLETE);
  fixture.forceError();
  assert.equal(await skill.detectState(fixture.observe()), FILE_PUSH_STATES.ERROR);
});

test("detectState recognizes Safari's download confirmation sheet", async () => {
  const skill = createFilePushSkill();
  const fixture = new SafariFixture({ requireDownloadConfirmation: true });
  fixture.phase = "download_confirmation";
  assert.equal(await skill.detectState(fixture.observe()), FILE_PUSH_STATES.DOWNLOAD_CONFIRMATION);
});

test("availableActions offers exactly one real action per non-terminal, non-error state", async () => {
  const skill = createFilePushSkill();
  assert.deepEqual(await skill.availableActions(FILE_PUSH_STATES.SPRINGBOARD), ["open_safari"]);
  assert.deepEqual(await skill.availableActions(FILE_PUSH_STATES.ADDRESS_BAR), ["navigate_to_link"]);
  assert.deepEqual(await skill.availableActions(FILE_PUSH_STATES.DOWNLOAD_CONFIRMATION), ["confirm_download"]);
  assert.deepEqual(await skill.availableActions(FILE_PUSH_STATES.DOWNLOAD_IN_PROGRESS), ["wait_for_download"]);
  assert.deepEqual(await skill.availableActions(FILE_PUSH_STATES.DOWNLOAD_COMPLETE), ["confirm_downloaded"]);
  assert.deepEqual(await skill.availableActions(FILE_PUSH_STATES.ERROR), []);
});

test("open_safari taps the real Safari icon location and verifies against the resulting state", async () => {
  const skill = createFilePushSkill();
  const fixture = new SafariFixture();
  const observation = fixture.observe();
  await skill.execute("open_safari", { device: fixture, observation });
  assert.equal(fixture.phase, "address_bar", "the tap must have landed on the Safari icon, not somewhere else");
  const verified = await skill.verify("open_safari", fixture.observe(), { state: FILE_PUSH_STATES.SPRINGBOARD });
  assert.equal(verified, true);
});

test("navigate_to_link types the real URL into the address bar and submits it", async () => {
  const skill = createFilePushSkill();
  const fixture = new SafariFixture();
  fixture.phase = "address_bar";
  const url = "https://hub.example/d/pfl_test-token";
  await skill.execute("navigate_to_link", { device: fixture, observation: fixture.observe(), url });
  assert.equal(fixture.typed.at(-1), `${url}\n`);
  assert.equal(fixture.phase, "downloading");
});

test("navigate_to_link requires a url", async () => {
  const skill = createFilePushSkill();
  const fixture = new SafariFixture();
  fixture.phase = "address_bar";
  await assert.rejects(() => skill.execute("navigate_to_link", { device: fixture, observation: fixture.observe() }), /requires a url/);
});

test("confirm_download taps Safari's button and rechecks authorization immediately before input", async () => {
  const skill = createFilePushSkill();
  const fixture = new SafariFixture({ requireDownloadConfirmation: true });
  fixture.phase = "download_confirmation";
  let authorized = 0;
  await skill.execute("confirm_download", {
    device: fixture,
    observation: fixture.observe(),
    authorize: async () => { authorized += 1; },
  });
  assert.equal(authorized, 1);
  assert.equal(fixture.phase, "downloading");
});

test("verify() escalates to NEEDS_HUMAN rather than guessing when Safari shows an error after input", async () => {
  const skill = createFilePushSkill();
  const fixture = new SafariFixture();
  fixture.forceError();
  const verified = await skill.verify("navigate_to_link", fixture.observe(), { state: FILE_PUSH_STATES.ADDRESS_BAR });
  assert.equal(verified.outcome, "NEEDS_HUMAN");
});

test("recover() presses Home to return to a known state, and reports why", async () => {
  const skill = createFilePushSkill();
  const fixture = new SafariFixture();
  fixture.phase = "downloading";
  const recovery = await skill.recover(new Error("something failed"), { device: fixture });
  assert.equal(recovery.recovered, true);
  assert.equal(recovery.destination, FILE_PUSH_STATES.SPRINGBOARD);
  assert.equal(recovery.reason, "file-push recovery requested (Error)");
  assert.equal(fixture.phase, "springboard");
});

export { SafariFixture };
