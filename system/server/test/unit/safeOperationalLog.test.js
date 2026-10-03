import test from "node:test";
import assert from "node:assert/strict";
import { logOperationalFailure, operationalErrorKind } from "../../src/safeOperationalLog.js";

test("operational errors expose only a bounded kind, never message or stack contents", () => {
  const entries = [];
  const error = new Error("SMTP failed for smtp://person@example.com:secret@smtp.example.com");
  error.code = "EAUTH";
  logOperationalFailure("Mail delivery failed", error, (...values) => entries.push(values.map(String).join(" ")));
  assert.deepEqual(entries, ["Mail delivery failed: EAUTH"]);
  assert.equal(entries[0].includes("secret"), false);
  assert.equal(entries[0].includes("person@example.com"), false);
});

test("malformed or attacker-controlled error kinds collapse to Error", () => {
  assert.equal(operationalErrorKind({ code: "token=secret value", name: "also unsafe/value" }), "Error");
  assert.equal(operationalErrorKind({ code: "X".repeat(65), name: "Error" }), "Error");
  assert.equal(operationalErrorKind({ code: "ETIMEDOUT" }), "ETIMEDOUT");
});
