import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import { PrivilegedOps } from "../../src/privilegedOps.js";

// Fakes Node's callback-style child_process.execFile(file, args, options, cb)
// — asserts on the exact argv, never actually spawns sudo/pfctl.
function fakeExecFile({ succeed = true, stdout = "", stderr = "" } = {}) {
  const calls = [];
  const execFile = (bin, args, options, callback) => {
    calls.push({ bin, args, options });
    if (succeed) callback(null, stdout, stderr);
    else callback(new Error("command failed"), stdout, stderr);
  };
  return { execFile, calls };
}

test("constructor requires a valid anchor path", () => {
  assert.throws(() => new PrivilegedOps({ anchor: undefined }), /valid PF anchor/);
  assert.throws(() => new PrivilegedOps({ anchor: "com.apple/phonefarm; rm -rf /" }), /valid PF anchor/);
  assert.doesNotThrow(() => new PrivilegedOps({ anchor: "com.apple/phonefarm" }));
});

test("testRuleset writes the ruleset to a private temp file and runs pfctl -nf through sudo -n", async () => {
  const { execFile, calls } = fakeExecFile();
  const ops = new PrivilegedOps({ execFile, sudoBin: "sudo", pfctlBin: "pfctl", anchor: "com.apple/phonefarm" });
  const result = await ops.testRuleset("pass in quick on bridge0 ...\n");
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, "sudo");
  assert.deepEqual(calls[0].args.slice(0, 2), ["-n", "pfctl"]);
  assert.equal(calls[0].args[2], "-nf");
  const filePath = calls[0].args[3];
  assert.equal(fs.existsSync(filePath), false, "the temp rule file must be cleaned up after the call");
});

test("testRuleset reports a syntax failure without throwing", async () => {
  const { execFile } = fakeExecFile({ succeed: false, stderr: "syntax error in rule" });
  const ops = new PrivilegedOps({ execFile, anchor: "com.apple/phonefarm" });
  const result = await ops.testRuleset("garbage");
  assert.equal(result.ok, false);
  assert.match(result.error, /syntax error/);
});

test("loadRuleset targets -a <anchor> -f <file>, never the bare main ruleset", async () => {
  const { execFile, calls } = fakeExecFile();
  const ops = new PrivilegedOps({ execFile, anchor: "com.apple/phonefarm" });
  await ops.loadRuleset("pass in quick on bridge0 ...\n");
  assert.deepEqual(calls[0].args.slice(0, 4), ["-n", "pfctl", "-a", "com.apple/phonefarm"]);
  assert.equal(calls[0].args[4], "-f");
});

test("inspectRules returns pfctl's stdout for this app's anchor only", async () => {
  const { execFile, calls } = fakeExecFile({ stdout: "pass in quick on bridge0 ...\n" });
  const ops = new PrivilegedOps({ execFile, anchor: "com.apple/phonefarm" });
  const output = await ops.inspectRules();
  assert.equal(output, "pass in quick on bridge0 ...\n");
  assert.deepEqual(calls[0].args, ["-n", "pfctl", "-a", "com.apple/phonefarm", "-vvs", "rules"]);
});

test("clearState validates the IPv4 before ever shelling out", async () => {
  const { execFile, calls } = fakeExecFile();
  const ops = new PrivilegedOps({ execFile, anchor: "com.apple/phonefarm" });
  await ops.clearState("192.168.2.10");
  assert.deepEqual(calls[0].args, ["-n", "pfctl", "-k", "192.168.2.10"]);

  await assert.rejects(() => ops.clearState("not-an-ip"), /valid IPv4 address/);
  await assert.rejects(() => ops.clearState("192.168.2.10; rm -rf /"), /valid IPv4 address/);
  assert.equal(calls.length, 1, "no invalid IP should ever reach execFile");
});

test("clearAnchor removes only this app's anchor rules, matching -a <anchor> -F all", async () => {
  const { execFile, calls } = fakeExecFile();
  const ops = new PrivilegedOps({ execFile, anchor: "com.apple/phonefarm" });
  await ops.clearAnchor();
  assert.deepEqual(calls[0].args, ["-n", "pfctl", "-a", "com.apple/phonefarm", "-F", "all"]);
});

test("a failed privileged call surfaces stderr, truncated, never the raw Error stack", async () => {
  const { execFile } = fakeExecFile({ succeed: false, stderr: "pfctl: permission denied" });
  const ops = new PrivilegedOps({ execFile, anchor: "com.apple/phonefarm" });
  await assert.rejects(() => ops.loadRuleset("..."), /permission denied/);
});
