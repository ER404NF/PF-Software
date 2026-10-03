import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(here, "../../../client");
const page = fs.readFileSync(path.join(clientDir, "account-deletion.html"), "utf8");
const script = fs.readFileSync(path.join(clientDir, "account-deletion.js"), "utf8");
const shell = fs.readFileSync(path.join(clientDir, "index.html"), "utf8");

test("account deletion is reachable signed out and signed in with labelled confirmation controls", () => {
  assert.match(shell, /href="\/account-deletion\.html">Request deletion</);
  assert.match(shell, /href="\/account-deletion\.html">Privacy</);
  assert.match(page, /id="deletion-request-form"/);
  assert.match(page, /id="self-deletion-form" hidden/);
  assert.match(page, /Type DELETE MY ACCOUNT/);
  assert.match(page, /href="\/api\/me\/data-export"/);
  assert.match(page, /role="status" aria-live="polite"/);
  assert.match(page, /role="alert" aria-live="assertive"/);
  assert.match(page, /src="\/account-deletion\.js"/);
});

test("privacy UI uses the public and authenticated APIs without rendering server text as markup", () => {
  assert.match(script, /fetch\("\/api\/me"\)/);
  assert.match(script, /fetch\("\/api\/privacy\/deletion-requests"/);
  assert.match(script, /fetch\("\/api\/me\/deletion-request"/);
  assert.doesNotMatch(script, /innerHTML|insertAdjacentHTML|outerHTML/);
  assert.match(script, /textContent = body\.message/);
});
