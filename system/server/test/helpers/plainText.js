import assert from "node:assert/strict";

// Operator-facing text must be plain: no file paths, no function names, no
// ticket/gate/ADR labels, no old product name, and never just an error code.
// Used by every test that checks a message the operator will read.
const RULES = [
  [/PF-Software/i, "uses the old product name"],
  [/(^|[\s(])(?:~|\.{1,2})?\/[\w.-]+/, "contains a file path"],
  [/[A-Za-z]:[\\]/, "contains a Windows path"],
  [/\b[\w-]+\.(?:js|cjs|mjs|ts|json|md)\b/i, "mentions a source or config file"],
  [/\bsrc\//, "mentions a source folder"],
  [/\b[a-z_]\w*\(\)/, "contains a function call"],
  [/(^|[\s(])_[A-Za-z]\w*/, "contains a private function name"],
  [/\b[a-z]+(?:[A-Z][a-z0-9]+){2,}\b/, "contains a camelCase identifier"],
  [/\b(?:ADR|PF|TEST|GATE|MS)[- ]?\d+\b/i, "contains an internal ticket or gate label"],
  [/^[A-Z]\d{3}$/, "is only an error code"],
];

export function plainTextProblems(text) {
  if (typeof text !== "string" || !text.trim()) return ["is empty"];
  return RULES.filter(([pattern]) => pattern.test(text)).map(([, problem]) => problem);
}

export function assertPlainOperatorText(text, label = "operator text") {
  assert.deepEqual(plainTextProblems(text), [], `${label} must be plain language: ${JSON.stringify(text)}`);
}
