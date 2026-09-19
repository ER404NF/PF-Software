// Dependencies with known-vulnerable major versions must not creep back in.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = JSON.parse(fs.readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));

test("file uploads use Multer 2.x (1.x is deprecated and carries known vulnerabilities)", () => {
  assert.match(pkg.dependencies.multer, /^\^?2\./, `package.json asks for ${pkg.dependencies.multer}`);
  assert.ok(Number(require("multer/package.json").version.split(".")[0]) >= 2, "the installed Multer is 2.x or newer");
});
