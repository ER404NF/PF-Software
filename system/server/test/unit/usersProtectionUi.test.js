import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const app = fs.readFileSync(new URL("../../../client/app.js", import.meta.url), "utf8");

test("the users editor disables Active and Role for your own account and the last admin/host, and says why", () => {
  assert.match(app, /const lockReason = userProtection\.self \|\| userProtection\.lastAdministrator \? userProtection\.reason : null;/);
  assert.match(app, /if \(lockReason\) \{\s*active\.disabled = true;\s*role\.disabled = true;/);
  assert.match(app, /reasonLine\.className = "user-lock-reason"/);
  assert.match(app, /control\.setAttribute\("aria-describedby", `user-lock-\$\{user\.username\}`\)/);
});

test("the account menu shows the unavailable actions disabled, with the reason attached", () => {
  assert.match(app, /const ownAccountNote = "You can't do this to the account you're signed in with\.";/);
  assert.match(app, /deleteButton\.disabled = protection\.canDelete !== true;/);
  assert.match(app, /button\.setAttribute\("aria-describedby", note\.id\)/);
});

test("Delete account needs the username typed, then calls the delete route", () => {
  assert.match(app, /window\.prompt\(`Delete \$\{user\.username\}\?/);
  assert.match(app, /method: "DELETE",[\s\S]*confirmUsername: user\.username/);
  assert.match(app, /Nothing was deleted: the username you typed did not match\./);
});

test("a manager gets the menu with Delete only; Kick and Change role stay with people who manage users", () => {
  assert.match(app, /wrap\.hidden = !canManagePeople\(\);/);
  assert.match(app, /if \(can\(UI_CAPABILITIES\.MANAGE_USERS\)\) actionsPanel\.append\(kickButton, changeRoleButton, rolePanel\);/);
});

const html = fs.readFileSync(new URL("../../../client/index.html", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../../../client/style.css", import.meta.url), "utf8");

test("the create-user form starts with Username, keeps its note small, and puts the checkbox and button on one row", () => {
  const form = html.slice(html.indexOf('id="user-create-form"'), html.indexOf("</form>", html.indexOf('id="user-create-form"')));
  assert.ok(form.indexOf("user-create-username") < form.indexOf("user-create-full-name"));
  assert.ok(form.indexOf("user-create-full-name") < form.indexOf("user-create-email"));
  assert.match(form, /<div class="user-form-footer">\s*<label class="user-checkbox">[\s\S]*<button type="submit">Create user<\/button>\s*<\/div>/);
  assert.match(css, /\.user-form \.user-form-note \{ grid-column: 1 \/ -1;/);
});

test("Operations calls its tab strip 'Sections' because the tabs swap what is on screen", () => {
  assert.match(html, /<nav id="operations-nav"[^>]*>\s*<span>Sections<\/span>/);
  assert.doesNotMatch(html, /Jump to/);
});

test("Save, Sign out all sessions and Reset 2FA look different on purpose: primary, plain, destructive", () => {
  assert.match(app, /revoke\.className = "secondary-action"/);
  assert.match(app, /resetTwoFactor\.className = "destructive-action"/);
  assert.match(css, /\.user-form button\.destructive-action[^{]*\{[^}]*color: var\(--offline\)/);
});

test("a text box in the form shows a ring only for keyboard use, never as a leftover from a click", () => {
  assert.match(css, /\.user-form input:focus:not\(:focus-visible\)[^{]*\{ outline: none; box-shadow: none; \}/);
});

test("your own row writes its reason once, inside the account menu, instead of a loose note that points at nothing", () => {
  assert.match(app, /if \(user\.actionReason && !user\.protection\?\.self\) \{/);
  assert.match(app, /if \(user\.actionReason\) noteLines\.push\(user\.actionReason\);/);
});
