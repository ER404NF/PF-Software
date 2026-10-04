import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { hashPassword, verifyPassword } from "../../src/authStore.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(testDir, "../../scripts/set-main-host.js");

test("the local main-host CLI promotes the sole admin without changing its password", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-main-host-cli-"));
  const configPath = path.join(root, "operators.json");
  const passwordHash = hashPassword("trial-password-123");
  fs.writeFileSync(configPath, `${JSON.stringify({ operators: [{
    username: "Trial1",
    passwordHash,
    role: "admin",
    allowedDevices: null,
    active: true,
    accountStatus: "approved",
  }] }, null, 2)}\n`);

  try {
    const first = spawnSync(process.execPath, [scriptPath, "Trial1"], {
      env: { ...process.env, OPERATORS_CONFIG_PATH: configPath },
      encoding: "utf8",
    });
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /Trial1.*main host/);

    const saved = JSON.parse(fs.readFileSync(configPath, "utf8")).operators[0];
    assert.equal(saved.role, "host");
    assert.equal(saved.isMainHost, true);
    assert.equal(saved.passwordHash, passwordHash);
    assert.equal(verifyPassword("trial-password-123", saved.passwordHash), true);

    const second = spawnSync(process.execPath, [scriptPath, "Trial1"], {
      env: { ...process.env, OPERATORS_CONFIG_PATH: configPath },
      encoding: "utf8",
    });
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /Trial1.*main host/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
