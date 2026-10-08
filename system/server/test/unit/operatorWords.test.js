import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Developer words must not reach a person. This scans the strings that can be shown (error and message values, JSON
// and send bodies, Error messages, text set on the page, labels, titles, placeholders and the visible text of the
// HTML pages) for words an operator should never read. Internal identifiers, route paths, comments and console lines
// are not scanned. A string that no operator can see is listed in ALLOWED with the reason.

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const FORBIDDEN = /\b(relay|provisioning|provisioner|orchestrator|reconcil\w*|supervisor|udid)\b/i;

// file (relative to the repository) -> exact string fragments that are allowed there, each with the reason
const ALLOWED = {
  "system/server/src/deviceRegistry.js": ["requires a valid UDID", "Duplicate WDA UDID"], // a configuration file error read by whoever edits devices.config.json, thrown at start-up before any page exists
  "system/server/src/deviceProvisioningStore.js": ["provisioning record requires a logicalId", "device-provisioning store is corrupt", "invalid UDID"], // internal start-up errors on the host's own data file
  "system/server/src/provisioningResults.js": ["unknown provisioning result", "provisioning result already defined"], // thrown only by a programming mistake (a result code that does not exist); no operator action can cause it
};

const SERVER_FILES = [
  "system/server/src/index.js", "system/server/src/provisioningResults.js", "system/server/src/errorCatalog.js",
  "system/server/src/deviceProvisioner.js", "system/server/src/networkVerifier.js", "system/server/src/proxyTester.js",
  "system/server/src/processSupervisor.js", "system/server/src/usbNetworkMapper.js", "system/server/src/hostPreflight.js",
  "system/server/src/networkRoutingOrchestrator.js", "system/server/src/wdaDevice.js", "system/server/src/deviceRegistry.js",
  "system/server/src/deviceProvisioningStore.js",
];
const listJs = dir => fs.existsSync(path.join(repo, dir)) ? fs.readdirSync(path.join(repo, dir)).filter(name => name.endsWith(".js")).map(name => `${dir}/${name}`) : [];
const ROUTE_FILES = listJs("system/server/src/routes");
const CLIENT_FILES = listJs("system/client");
const DESKTOP_FILES = ["desktop/main.js", "desktop/menu.js", "desktop/hostFixes.js", "desktop/hostEnvironment.js", "desktop/diagnostics.js", "desktop/serverSupervisor.js", "desktop/shutdown.js", "desktop/orphanRecovery.js"];
const HTML_FILES = ["system/client/index.html", "system/client/account-deletion.html", "desktop/first-run.html"];

// A line can show text to a person when it assigns or passes one of these.
const CONTEXT = /\b(error|message|reason|detail|note|hint|why|operatorAction|publicMessage|safeState|summary|title|label|text|textContent|description|placeholder)\b\s*[:=]|\.json\(|\.send\(|\bnew\s+\w*Error\(|\bError\(|aria-label|accountError\(|httpAuthorizationError\(|LifecycleError\(|showMessageBox/;

function withoutComments(source) {
  return source.split(/\r?\n/).map(line => line.replace(/^\s*\/\/.*$/, "").replace(/(^|[^:"'`\\])\/\/\s.*$/, "$1")).join("\n");
}

function stringsOnLine(line) {
  const found = [];
  const pattern = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;
  let match;
  while ((match = pattern.exec(line))) found.push((match[1] ?? match[2] ?? match[3] ?? "").replace(/\$\{[^}]*\}/g, " "));
  return found;
}

function findings(file) {
  const source = withoutComments(fs.readFileSync(path.join(repo, file), "utf8"));
  const allowed = ALLOWED[file] ?? [];
  const hits = [];
  source.split("\n").forEach((line, index) => {
    if (/^\s*(import|export)\b.*from\b|\brequire\(/.test(line) || /console\.(log|error|warn|info)\(/.test(line)) return;
    if (!CONTEXT.test(line)) return;
    for (const text of stringsOnLine(line)) {
      if (!FORBIDDEN.test(text)) continue;
      if (allowed.some(fragment => text.includes(fragment))) continue;
      hits.push(`${file}:${index + 1}: ${text.trim().slice(0, 120)}`);
    }
  });
  return hits;
}

function htmlFindings(file) {
  let html = fs.readFileSync(path.join(repo, file), "utf8");
  html = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  const texts = [...html.matchAll(/>([^<>]+)</g)].map(match => match[1]);
  const attributes = [...html.matchAll(/\b(?:title|aria-label|placeholder|alt)="([^"]*)"/g)].map(match => match[1]);
  return [...texts, ...attributes].map(text => text.trim()).filter(text => FORBIDDEN.test(text)).map(text => `${file}: ${text.slice(0, 120)}`);
}

test("no developer word reaches a person in the server messages, routes, client scripts, pages or desktop dialogs", () => {
  const hits = [
    ...[...SERVER_FILES, ...ROUTE_FILES, ...CLIENT_FILES, ...DESKTOP_FILES].filter(file => fs.existsSync(path.join(repo, file))).flatMap(findings),
    ...HTML_FILES.filter(file => fs.existsSync(path.join(repo, file))).flatMap(htmlFindings),
  ];
  assert.deepEqual(hits, []);
});

test("the allow-list stays short: every entry is a start-up or data-file message no page ever shows", () => {
  const entries = Object.values(ALLOWED).flat();
  assert.ok(entries.length <= 10, `${entries.length} entries; if more are needed, re-plan the scan`);
});

test("the scanner sees the old messages (so a pass means something)", () => {
  const sample = ['res.status(409).json({ error: "automatic device provisioning is not enabled on this relay" });'];
  const found = sample.flatMap(line => (CONTEXT.test(line) ? stringsOnLine(line).filter(text => FORBIDDEN.test(text)) : []));
  assert.equal(found.length, 1);
});

test("the proxy test announces itself as Bodun, never under the old product name", () => {
  const source = fs.readFileSync(path.join(repo, "system/server/src/proxyTester.js"), "utf8");
  assert.match(source, /User-Agent: Bodun-Proxy-Test/);
  assert.doesNotMatch(source, /PF-Software/);
});

test("the updater still points at the real release address (untouched)", () => {
  const source = fs.readFileSync(path.join(repo, "desktop/autoUpdate.js"), "utf8");
  assert.match(source, /repos\/ER404NF\/PF-Software\/releases/);
});
