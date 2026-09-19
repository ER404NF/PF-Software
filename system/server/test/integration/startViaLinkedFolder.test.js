// The real server and the real site agent, started the way the installer's verification starts them: through a folder
// that is a symlink. Before the fix both silently exited with code 0 (the server never listened).
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const serverDir = path.resolve("server");

function isolatedEnv(root) {
  const env = {
    ...process.env,
    PORT: "0", HOST: "127.0.0.1",
    SESSION_SECRET: crypto.randomBytes(32).toString("hex"), TWO_FACTOR_MASTER_KEY: crypto.randomBytes(32).toString("hex"),
    DESKTOP_AUTO_DEVICE_MODE: "true", AUTO_DISCOVER_IOS_DEVICES: "false",
    OPERATORS_CONFIG_PATH: path.join(root, "operators.json"), SESSION_STORE_DIR: path.join(root, "sessions"),
    AUDIT_LOG_PATH: path.join(root, "audit.log"), QUEUE_STORE_PATH: path.join(root, "queue.json"),
    MODEL_SELECTION_STORE_PATH: path.join(root, "models.json"), ASSIGNMENT_STORE_PATH: path.join(root, "assignments.json"),
    RESEARCH_STORE_DIR: path.join(root, "research"), RESEARCH_EVIDENCE_DIR: path.join(root, "evidence"), FILE_STORE_DIR: path.join(root, "files"),
    ACCOUNT_NOTIFICATION_STORE_PATH: path.join(root, "notifications.json"), DEVICE_PROVISIONING_STORE_PATH: path.join(root, "provisioning.json"),
    WDA_DERIVED_DATA_ROOT: path.join(root, "wda"), PROXY_POOL_STORE_PATH: path.join(root, "proxies.json"), USB_NETWORK_STORE_PATH: path.join(root, "usb.json"),
    SITE_STORE_PATH: path.join(root, "sites.json"),
  };
  delete env.DEVICE_CONFIG_PATH;
  for (const name of ["HUB_URL", "SITE_ID", "SITE_TOKEN"]) delete env[name];
  return env;
}

function linkedServerFolder(root) {
  const link = path.join(root, "linked-server");
  fs.symlinkSync(serverDir, link, "junction");
  assert.notEqual(fs.realpathSync(path.join(link, "src", "index.js")), path.join(link, "src", "index.js"), "the path really goes through a link");
  return link;
}

test("the server started through a symlinked folder listens instead of exiting silently", { timeout: 60_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-link-"));
  const child = spawn(process.execPath, [path.join(linkedServerFolder(root), "src", "index.js")], { env: isolatedEnv(root), stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let exited = null;
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  child.on("exit", code => { exited = code; });
  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && exited === null && !/running at http/.test(output)) await new Promise(resolve => setTimeout(resolve, 100));
    assert.match(output, /running at http:\/\/127\.0\.0\.1:\d+/, `no listening line (exit=${exited}). Output:\n${output.slice(-800)}`);
    assert.equal(exited, null, "still running");
  } finally {
    child.kill();
    await new Promise(resolve => (exited !== null ? resolve() : child.once("exit", resolve)));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the site agent started through a symlinked folder really runs (it reports its missing settings instead of exiting silently)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-link-"));
  try {
    const result = spawnSync(process.execPath, [path.join(linkedServerFolder(root), "src", "agentMain.js")], { env: isolatedEnv(root), encoding: "utf8", timeout: 20_000 });
    assert.equal(result.status, 1, `exit=${result.status} stderr=${result.stderr}`);
    assert.match(result.stderr, /Missing HUB_URL, SITE_ID, SITE_TOKEN/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
