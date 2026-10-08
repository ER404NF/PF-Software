import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Found by the real-click sweep: pressing "Change username" without typing a new name answered
// "Username already exists." (the account's own name). The page now says what is actually going on, without a request.
const app = fs.readFileSync(new URL("../../../client/app.js", import.meta.url), "utf8");

test("an unchanged username is answered on the page with a plain sentence and sends nothing", () => {
  assert.match(
    app,
    /renameButton\.addEventListener\("click", async \(\) => \{\s*usersMessageEl\.textContent = "";\s*if \(renameInput\.value\.trim\(\) === user\.username\) \{\s*usersMessageEl\.textContent = `\$\{user\.username\} already has this username\. Type a different one first\.`;\s*return;\s*\}/,
  );
});
