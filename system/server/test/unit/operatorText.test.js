import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { ERROR_CATALOG } from "../../src/errorCatalog.js";
import { plainTextProblems } from "../helpers/plainText.js";

// What an operator reads on a phone's error panel: the name, what happened, and what to do.
const context = { window: {} };
vm.runInNewContext(fs.readFileSync(new URL("../../../client/deviceCardModel.js", import.meta.url), "utf8"), context);
const { formatDiagnostics } = context.window.deviceCardModel;

const OPERATOR_FIELDS = ["name", "publicMessage", "operatorAction", "safeState"];

test("every error an operator can see is written in plain language and never uses the old product name", () => {
  const problems = [];
  for (const [code, entry] of Object.entries(ERROR_CATALOG)) {
    for (const field of OPERATOR_FIELDS) {
      if (entry[field] === undefined) continue;
      const found = plainTextProblems(entry[field]);
      if (found.length) problems.push(`${code}.${field}: ${found.join(", ")} — ${JSON.stringify(entry[field])}`);
    }
  }
  assert.deepEqual(problems, []);
});

test("the diagnostics box shows plain lines, keeps the phone's id whole and leaves out code locations", () => {
  const text = formatDiagnostics({
    deviceId: "00008110-001A2B3C4D5E601E",
    health: { iproxy: "FAILED", sourceFile: "system/server/src/x.js", sourceFunction: "_onDetach" },
    location: "_onDetach() | system/server/src/x.js",
    events: [{ at: "10:01", note: "port in use" }],
    empty: null,
  });
  assert.match(text, /^Device id: 00008110-001A2B3C4D5E601E$/m);
  assert.match(text, /^ {2}Iproxy: FAILED$/m);
  assert.match(text, /^ {2}1\.$/m);
  assert.doesNotMatch(text, /system\/server|_onDetach|Location|Empty/);
});
