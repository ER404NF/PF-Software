const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyAdvisories, collectDependencyNames, gateDecision } = require("../scripts/audit-gate.cjs");

// The shape of the 14 findings the Mac build reported: 13 high + 1 critical.
const REPORTED = {
  electron: { severity: "high", isDirect: true, range: "<=40.10.2", fixAvailable: { name: "electron", version: "44.4.2", isSemVerMajor: true } },
  "electron-builder": { severity: "high", isDirect: true, range: "<=26.14.0", fixAvailable: { name: "electron-builder", version: "26.15.3", isSemVerMajor: true } },
  "app-builder-lib": { severity: "high", isDirect: false, range: "<=26.14.0", fixAvailable: { name: "electron-builder", version: "26.15.3", isSemVerMajor: true } },
  tar: { severity: "critical", isDirect: false, range: "<=7.5.20", fixAvailable: { name: "electron-builder", version: "26.15.3", isSemVerMajor: true } },
  "extract-zip": { severity: "high", isDirect: false, range: "*", fixAvailable: { name: "electron", version: "44.4.2", isSemVerMajor: true } },
};

test("Electron itself is classified as shipped; electron-builder's tree is build-only", () => {
  const { shipped, buildOnly } = classifyAdvisories(REPORTED, new Set());
  assert.deepEqual(shipped.map(finding => finding.name), ["electron"]);
  assert.deepEqual(buildOnly.map(finding => finding.name).sort(), ["app-builder-lib", "electron-builder", "extract-zip", "tar"]);
  assert.equal(shipped[0].fix, "electron@44.4.2 (major)");
});

test("production dependencies are always shipped", () => {
  const { shipped } = classifyAdvisories({ express: { severity: "high", isDirect: true, range: "<4", fixAvailable: true } }, new Set(["express"]));
  assert.equal(shipped.length, 1);
  assert.equal(shipped[0].fix, "available");
});

test("a shipped high/critical finding always fails the gate and cannot be waived", () => {
  const classified = classifyAdvisories({ electron: REPORTED.electron }, new Set());
  assert.equal(gateDecision(classified).failed, true);
  assert.equal(gateDecision(classified, { allowBuildOnly: true }).failed, true);
});

test("a build-only high/critical finding fails by default and is only waived explicitly", () => {
  const classified = classifyAdvisories({ tar: REPORTED.tar }, new Set());
  assert.equal(gateDecision(classified).failed, true);
  const waived = gateDecision(classified, { allowBuildOnly: true });
  assert.equal(waived.failed, false);
  assert.equal(waived.blockingBuild.length, 1, "the waived finding is still reported");
});

test("moderate and low findings do not block, and an empty report passes", () => {
  const classified = classifyAdvisories({ minor: { severity: "moderate", isDirect: false, range: "*", fixAvailable: false } }, new Set());
  assert.equal(gateDecision(classified).failed, false);
  assert.equal(gateDecision(classifyAdvisories({}, new Set())).failed, false);
});

test("the production dependency set is read from the npm ls tree", () => {
  const tree = { dependencies: { express: { dependencies: { qs: {} } }, ws: {} } };
  assert.deepEqual([...collectDependencyNames(tree)].sort(), ["express", "qs", "ws"]);
});
