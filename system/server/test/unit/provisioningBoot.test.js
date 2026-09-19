// startAutoProvisioning must use the environment it is GIVEN, not the global process.env.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startAutoProvisioning } from "../../src/provisioningBoot.js";

function harness(env, { preflightOk = true } = {}) {
  const seen = { preflight: null, wda: null, iproxy: null, provisioner: null, discovered: null, started: false };
  const deps = {
    runPreflight: options => { seen.preflight = options; return { ok: preflightOk, checks: preflightOk ? [] : [{ id: "xcode", ok: false, message: "nope" }] }; },
    discover: options => { seen.discovered = options; return []; },
    createWdaManager: options => { seen.wda = options; return { name: "wda" }; },
    createIproxyManager: options => { seen.iproxy = options; return { name: "iproxy" }; },
    createProvisioner: options => { seen.provisioner = options; return { start() { seen.started = true; }, options }; },
  };
  const result = startAutoProvisioning({ env, devices: new Map(), manualUdids: new Set(), deps });
  return { result, seen };
}

const HOST_ENV = {
  AUTO_PROVISION_WDA: "true", WDA_REPO_PATH: "/Users/op/WebDriverAgent",
  IPROXY_BIN: "/opt/homebrew/bin/iproxy", XCODE_SELECT_BIN: "/usr/bin/xcode-select", XCODEBUILD_BIN: "/usr/bin/xcodebuild",
  IDEVICE_ID_BIN: "/opt/homebrew/bin/idevice_id", IDEVICEINFO_BIN: "/opt/homebrew/bin/ideviceinfo",
  WDA_DEVELOPMENT_TEAM: "ABCDE12345", WDA_BUNDLE_ID: "com.example.wda",
};

test("nothing starts unless AUTO_PROVISION_WDA is exactly true", () => {
  assert.equal(startAutoProvisioning({ env: {}, devices: new Map(), manualUdids: new Set() }), undefined);
  assert.equal(startAutoProvisioning({ env: { AUTO_PROVISION_WDA: "1" }, devices: new Map(), manualUdids: new Set() }), undefined);
});

test("every tool and signing setting comes from the supplied environment", () => {
  const { result, seen } = harness(HOST_ENV);
  assert.equal(seen.started, true);
  assert.ok(result);
  assert.deepEqual(seen.preflight, {
    wdaRepoPath: "/Users/op/WebDriverAgent",
    iproxyBin: "/opt/homebrew/bin/iproxy", xcodeSelectBin: "/usr/bin/xcode-select", xcodebuildBin: "/usr/bin/xcodebuild",
    ideviceIdBin: "/opt/homebrew/bin/idevice_id", ideviceInfoBin: "/opt/homebrew/bin/ideviceinfo",
  });
  assert.deepEqual(seen.wda, {
    wdaRepoPath: "/Users/op/WebDriverAgent", xcodebuildBin: "/usr/bin/xcodebuild",
    developmentTeam: "ABCDE12345", bundleId: "com.example.wda",
  });
  assert.deepEqual(seen.iproxy, { bin: "/opt/homebrew/bin/iproxy" });
  seen.provisioner.discoverIosDevices();
  assert.deepEqual(seen.discovered, { ideviceIdBin: "/opt/homebrew/bin/idevice_id", ideviceInfoBin: "/opt/homebrew/bin/ideviceinfo" });
});

test("a value that exists only in the global process.env is NOT picked up", () => {
  const saved = { ...process.env };
  Object.assign(process.env, {
    IPROXY_BIN: "/global/iproxy", XCODEBUILD_BIN: "/global/xcodebuild", IDEVICE_ID_BIN: "/global/idevice_id",
    WDA_DEVELOPMENT_TEAM: "GLOBALTEAM", WDA_BUNDLE_ID: "com.global.wda", WDA_REPO_PATH: "/global/wda",
  });
  try {
    const { seen } = harness({ AUTO_PROVISION_WDA: "true" });
    assert.equal(seen.preflight.iproxyBin, "iproxy", "falls back to the bare command name, not to the global setting");
    assert.equal(seen.preflight.xcodebuildBin, "xcodebuild");
    assert.equal(seen.preflight.wdaRepoPath, undefined);
    assert.equal(seen.wda.developmentTeam, null);
    assert.equal(seen.wda.bundleId, null);
    assert.equal(seen.iproxy.bin, "iproxy");
    seen.provisioner.discoverIosDevices();
    assert.equal(seen.discovered.ideviceIdBin, "idevice_id");
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test("a failed preflight starts nothing and says why", () => {
  const original = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.join(" "));
  try {
    const { result, seen } = harness(HOST_ENV, { preflightOk: false });
    assert.equal(result, null);
    assert.equal(seen.started, false);
    assert.equal(seen.provisioner, null);
    assert.ok(lines.some(line => /\[xcode\] nope/.test(line)));
  } finally {
    console.error = original;
  }
});
