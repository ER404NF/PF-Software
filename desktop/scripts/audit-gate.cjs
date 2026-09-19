#!/usr/bin/env node
// Dependency-audit gate that reports WHAT each finding can reach instead of a
// single opaque "14 vulnerabilities" total.
//
//   shipped     code that ends up inside the installed application: production
//               dependencies, plus the Electron runtime itself (Chromium + Node
//               are bundled into every Phone Farm.app).
//   build-only  tooling that only runs on the build machine (electron-builder and
//               its dependency tree, electron's download helpers) and never ships.
//
// A high/critical finding in EITHER group fails the gate by default: build-only
// findings cannot reach users, but they do reach the machine that signs the
// installer, so they are not hidden. PHONE_FARM_AUDIT_ALLOW_BUILD_ONLY=true (or
// --allow-build-only) downgrades build-only findings to a loud warning; shipped
// findings can never be waived.
//
//   node scripts/audit-gate.cjs [--dir <package dir>] [--allow-build-only]

const path = require("path");
const { spawnSync } = require("child_process");

const BLOCKING = new Set(["high", "critical"]);
// Packages that are part of the shipped application even when declared as devDependencies.
const ALWAYS_SHIPPED = new Set(["electron"]);

function classifyAdvisories(vulnerabilities, shippedPackages = new Set()) {
  const shipped = [];
  const buildOnly = [];
  for (const [name, entry] of Object.entries(vulnerabilities || {})) {
    const finding = {
      name,
      severity: entry.severity,
      range: entry.range,
      direct: Boolean(entry.isDirect),
      fix: entry.fixAvailable && entry.fixAvailable.name
        ? `${entry.fixAvailable.name}@${entry.fixAvailable.version}${entry.fixAvailable.isSemVerMajor ? " (major)" : ""}`
        : (entry.fixAvailable === true ? "available" : "none"),
    };
    (shippedPackages.has(name) || ALWAYS_SHIPPED.has(name) ? shipped : buildOnly).push(finding);
  }
  return { shipped, buildOnly };
}

function gateDecision({ shipped, buildOnly }, { allowBuildOnly = false } = {}) {
  const blockingShipped = shipped.filter(finding => BLOCKING.has(finding.severity));
  const blockingBuild = buildOnly.filter(finding => BLOCKING.has(finding.severity));
  return {
    failed: blockingShipped.length > 0 || (!allowBuildOnly && blockingBuild.length > 0),
    blockingShipped,
    blockingBuild,
  };
}

function npmJson(args, cwd) {
  const command = process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : "npm";
  const fullArgs = process.platform === "win32" ? ["/d", "/s", "/c", "npm.cmd", ...args] : args;
  const result = spawnSync(command, fullArgs, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  // npm audit exits non-zero when it finds vulnerabilities; the JSON is still on stdout.
  return JSON.parse(result.stdout || "{}");
}

function collectDependencyNames(tree, names = new Set()) {
  for (const [name, child] of Object.entries(tree?.dependencies || {})) {
    names.add(name);
    collectDependencyNames(child, names);
  }
  return names;
}

function runAudit(dir) {
  const audit = npmJson(["audit", "--json"], dir);
  if (audit.error) throw new Error(`npm audit failed in ${dir}: ${audit.error.summary || audit.error.code || "unknown error"}`);
  const production = npmJson(["ls", "--omit=dev", "--all", "--json"], dir);
  return { audit, shippedPackages: collectDependencyNames(production) };
}

function formatTable(title, findings) {
  if (findings.length === 0) return `${title}: none`;
  const rows = findings.map(f => `  ${f.severity.padEnd(9)} ${f.name.padEnd(30)} direct=${String(f.direct).padEnd(5)} fix=${f.fix}`);
  return `${title}:\n${rows.join("\n")}`;
}

function main(argv = process.argv.slice(2), env = process.env) {
  const dirIndex = argv.indexOf("--dir");
  const dir = path.resolve(dirIndex >= 0 ? argv[dirIndex + 1] : process.cwd());
  const allowBuildOnly = argv.includes("--allow-build-only") || env.PHONE_FARM_AUDIT_ALLOW_BUILD_ONLY === "true";
  const { audit, shippedPackages } = runAudit(dir);
  const classified = classifyAdvisories(audit.vulnerabilities, shippedPackages);
  const decision = gateDecision(classified, { allowBuildOnly });
  const totals = audit.metadata?.vulnerabilities ?? {};
  console.log(`npm audit in ${dir}: ${JSON.stringify(totals)}`);
  console.log(formatTable("Reaches the installed application (shipped)", classified.shipped));
  console.log(formatTable("Build machine only (never shipped)", classified.buildOnly));
  if (decision.failed) {
    console.error(`\nFAIL: ${decision.blockingShipped.length} high/critical shipped finding(s), ${decision.blockingBuild.length} high/critical build-only finding(s)${allowBuildOnly ? " (build-only waived)" : ""}.`);
    process.exit(1);
  }
  if (decision.blockingBuild.length) console.warn("\nWARNING: high/critical build-only findings were waived explicitly. They cannot reach users but do reach the signing machine.");
  console.log("\nAudit gate passed.");
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = { ALWAYS_SHIPPED, classifyAdvisories, collectDependencyNames, gateDecision };
