import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../client");
const read = name => fs.readFileSync(path.join(clientDir, name), "utf8");
const manifest = JSON.parse(read("manifest.webmanifest"));

function pngSize(file) {
  const bytes = fs.readFileSync(path.join(clientDir, file));
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${file} is a PNG`);
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

test("the manifest has everything browsers require to offer 'install app'", () => {
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/");
  assert.ok(manifest.name && manifest.short_name);
  const sizes = manifest.icons.map(icon => `${icon.sizes}:${icon.purpose}`);
  assert.ok(sizes.includes("192x192:any") && sizes.includes("512x512:any") && sizes.includes("512x512:maskable"));
});

test("every icon the manifest names exists with exactly the size it claims", () => {
  for (const icon of manifest.icons) {
    const [width, height] = pngSize(icon.src);
    assert.equal(`${width}x${height}`, icon.sizes, icon.src);
  }
  assert.deepEqual(pngSize("icons/apple-touch-icon.png"), [180, 180]);
  assert.match(read("icons/icon.svg"), /^<svg /);
});

test("the page links the manifest, icons and theme colour, and registers the service worker", () => {
  const html = read("index.html");
  assert.match(html, /<link rel="manifest" href="manifest\.webmanifest"/);
  assert.match(html, /<link rel="apple-touch-icon"/);
  assert.match(html, /<meta name="theme-color"/);
  assert.match(html, /viewport-fit=cover/);
  assert.match(read("app.js"), /serviceWorker\.register\("\/sw\.js"\)/);
  assert.doesNotMatch(html, /\(dev\)/, "no development label in the shipped title");
});

test("the service worker never caches per-operator data and fetches the shell network-first", () => {
  const worker = read("sw.js");
  assert.match(worker, /pathname\.startsWith\("\/api\/"\)/);
  assert.match(worker, /\/agent-link/);
  assert.match(worker, /request\.method !== "GET"/);
  assert.match(worker, /await fetch\(request\)[\s\S]*catch[\s\S]*caches\.match/, "network first, cache only as the offline fallback");
  // Only the static shell may ever be stored.
  assert.match(worker, /SHELL\.includes\(url\.pathname\)/);
  for (const forbidden of ["/api", "storage", "sessions"]) {
    const shell = worker.match(/const SHELL = \[([\s\S]*?)\];/)[1];
    assert.equal(shell.includes(forbidden), false, `${forbidden} must not be pre-cached`);
  }
  // Every shell file it pre-caches really exists.
  const shell = [...worker.match(/const SHELL = \[([\s\S]*?)\];/)[1].matchAll(/"\/([^"]*)"/g)].map(match => match[1]).filter(Boolean);
  for (const file of shell) assert.ok(fs.existsSync(path.join(clientDir, file)), `${file} exists`);
});
