import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const testRoot = path.resolve(scriptDir, "../test");

function collectTests(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .flatMap(entry => {
      const target = path.join(directory, entry.name);
      return entry.isDirectory() ? collectTests(target) : entry.name.endsWith(".test.js") ? [target] : [];
    })
    .sort((left, right) => left.localeCompare(right));
}

function summaryCount(output, label) {
  const match = output.match(new RegExp(`(?:ℹ|#) ${label} (\\d+)`, "g"))?.at(-1);
  return match ? Number.parseInt(match.match(/\d+$/)[0], 10) : 0;
}

const files = collectTests(testRoot);
let tests = 0;
let passed = 0;
let failed = 0;
let skipped = 0;
let processFailures = 0;

for (const file of files) {
  const relative = path.relative(process.cwd(), file);
  process.stdout.write(`\n--- ${relative} ---\n`);
  const result = spawnSync(process.execPath, ["--test", file], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  process.stdout.write(output);
  tests += summaryCount(output, "tests");
  passed += summaryCount(output, "pass");
  failed += summaryCount(output, "fail");
  skipped += summaryCount(output, "skipped");
  if (result.error) {
    processFailures += 1;
    process.stderr.write(`${relative}: ${result.error.message}\n`);
  } else if (result.status !== 0) {
    processFailures += 1;
  }
}

process.stdout.write(`\nFull suite: ${files.length} files, ${tests} tests, ${passed} passed, ${failed} failed, ${skipped} skipped.\n`);
if (processFailures > 0 || failed > 0 || passed + failed + skipped !== tests) process.exitCode = 1;
