// npm run bench            print the before/after table
// npm run bench -- --update-baseline   record the current numbers as the regression baseline
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runBenchmark, ALL_OFF, ALL_ON, OPTIMIZATIONS, regressionViolations } from "./researchBench.js";

const baselinePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "baseline.json");
const before = await runBenchmark({ flags: ALL_OFF });
const after = await runBenchmark({ flags: ALL_ON });
const rows = [["all optimizations off", before], ["all optimizations on", after]];
for (const name of OPTIMIZATIONS) rows.push([`only ${name}`, await runBenchmark({ flags: { ...ALL_OFF, [name]: true } })]);

const pad = (value, width) => String(value).padEnd(width);
console.log(`${pad("configuration", 26)}${pad("success", 9)}${pad("$ / session", 13)}${pad("latency s", 11)}${pad("model calls", 13)}${pad("strong", 8)}shots`);
for (const [label, result] of rows) {
  console.log(`${pad(label, 26)}${pad(result.successRate, 9)}${pad(result.costPerSessionUsd, 13)}${pad((result.latencyPerSessionMs / 1000).toFixed(1), 11)}${pad(result.modelCallsPerSession, 13)}${pad(result.strongCallsPerSession, 8)}${result.screenshotsPerSession}`);
}
const problems = regressionViolations(before, after);
console.log(problems.length ? `\nREGRESSION: ${problems.join("; ")}` : "\nNo regression: success rate and accuracy are unchanged.");
console.log("(Costs and latencies are modeled, not measured; see the header of researchBench.js.)");

if (process.argv.includes("--update-baseline")) {
  fs.writeFileSync(baselinePath, JSON.stringify({ recordedFor: "sessions=16 seed=1", off: before, on: after }, null, 2) + "\n");
  console.log(`baseline written to ${baselinePath}`);
}
process.exit(problems.length ? 1 : 0);
