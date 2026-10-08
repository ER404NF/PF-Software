import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Found by the real-click sweep: Research and Review are two side panels that open in the same place. Opening one while the
// other was open left both open, stacked; pressing Close on the top one showed the other underneath, which looked like Close
// had done nothing. Opening one now closes the other.
const research = fs.readFileSync(new URL("../../../client/research.js", import.meta.url), "utf8");
const review = fs.readFileSync(new URL("../../../client/review.js", import.meta.url), "utf8");

test("opening Research closes Review first", () => {
  assert.match(
    research,
    /researchToggle\.addEventListener\("click", async \(\) => \{\s*if \(!researchPanel\.hidden\) return researchReset\(\);\s*(?:\/\/[^\r\n]*\s*)?if \(!document\.getElementById\("review-panel"\)\.hidden\) document\.getElementById\("review-toggle"\)\.click\(\);\s*researchPanel\.hidden = false;/,
  );
});

test("opening Review closes Research first", () => {
  assert.match(
    review,
    /reviewToggle\.addEventListener\("click", async \(\) => \{\s*if \(!reviewPanel\.hidden\) return reviewReset\(\);\s*(?:\/\/[^\r\n]*\s*)?if \(!document\.getElementById\("research-panel"\)\.hidden\) document\.getElementById\("research-toggle"\)\.click\(\);\s*reviewPanel\.hidden = false;/,
  );
});
