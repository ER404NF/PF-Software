const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  compareVersions,
  downloadInstaller,
  enforceReleaseVersion,
  normalizedVersion,
  selectInstallerAsset,
  selectRelease,
} = require("../autoUpdate");

function release(version, assets = []) {
  return { tag_name: `v${version}`, draft: false, prerelease: version.includes("-"), assets };
}

function asset(name, bytes = Buffer.from("verified installer")) {
  return {
    name,
    size: bytes.length,
    digest: `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`,
    browser_download_url: `https://github.com/ER404NF/PF-Software/releases/download/v0.2.0/${name}`,
  };
}

function response(body, { json, url = "https://api.github.com/repos/ER404NF/PF-Software/releases?per_page=30" } = {}) {
  return {
    ok: true,
    status: 200,
    url,
    body: body ? (async function* stream() { yield body; }()) : null,
    json: async () => json,
  };
}

test("versions are normalized and the highest non-draft release is selected", () => {
  assert.equal(normalizedVersion("v1.2.3").text, "1.2.3");
  assert.ok(compareVersions("1.10.0", "1.9.9") > 0);
  assert.ok(compareVersions("2.0.0", "2.0.0-beta.2") > 0);
  assert.equal(selectRelease([release("0.2.0"), release("1.0.0-beta.1"), { ...release("9.0.0"), draft: true }]).tag_name, "v1.0.0-beta.1");
});

test("platform installer selection prefers stable direct-download aliases", () => {
  const mac = asset("Phone-Farm-macOS.pkg");
  const win = asset("Phone-Farm-Windows.exe");
  const current = release("0.2.0", [asset("Phone-Farm-0.2.0-arm64.pkg"), mac, win]);
  assert.equal(selectInstallerAsset(current, "darwin", "arm64"), mac);
  assert.equal(selectInstallerAsset(current, "win32", "x64"), win);
  assert.equal(selectInstallerAsset(current, "linux", "x64"), null);
  assert.equal(selectInstallerAsset(current, "darwin", "x64"), null, "an Intel Mac must never receive the arm64 alias");
});

test("download accepts only the declared size and SHA-256 digest", async t => {
  const bytes = Buffer.from("verified installer");
  const metadata = asset("Phone-Farm-Windows.exe", bytes);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "phone-farm-update-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const target = await downloadInstaller(metadata, directory, {
    fetchImpl: async () => response(bytes, { url: "https://release-assets.githubusercontent.com/release.exe" }),
  });
  assert.deepEqual(fs.readFileSync(target), bytes);

  await assert.rejects(downloadInstaller({ ...metadata, digest: `sha256:${"0".repeat(64)}` }, directory, {
    fetchImpl: async () => response(bytes, { url: "https://release-assets.githubusercontent.com/release.exe" }),
  }), /SHA-256 verification/);
});

test("a current packaged version is allowed without opening an installer", async () => {
  let opened = false;
  const result = await enforceReleaseVersion({
    app: { isPackaged: true, getVersion: () => "0.2.0" },
    dialog: { showMessageBox: async () => assert.fail("no prompt expected") },
    shell: { openPath: async () => { opened = true; } },
    logger: { info() {}, warn() {}, error() {} },
    fetchImpl: async () => response(null, { json: [release("0.2.0")] }),
  });
  assert.equal(result.allowed, true);
  assert.equal(opened, false);
});

test("declining a mismatched version quits and never downloads", async () => {
  let quits = 0;
  let requests = 0;
  const installer = asset("Phone-Farm-Windows.exe");
  const result = await enforceReleaseVersion({
    app: { isPackaged: true, getVersion: () => "0.1.0", quit: () => { quits += 1; } },
    dialog: { showMessageBox: async () => ({ response: 1 }) },
    shell: { openPath: async () => assert.fail("must not open") },
    logger: { info() {}, warn() {}, error() {} },
    platform: "win32",
    fetchImpl: async () => { requests += 1; return response(null, { json: [release("0.2.0", [installer])] }); },
  });
  assert.equal(result.status, "declined");
  assert.equal(quits, 1);
  assert.equal(requests, 1);
});

test("accepting an update verifies, opens the installer, and quits", async t => {
  const bytes = Buffer.from("verified installer");
  const installer = asset("Phone-Farm-Windows.exe", bytes);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "phone-farm-update-app-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  let quits = 0;
  let opened;
  let request = 0;
  const result = await enforceReleaseVersion({
    app: { isPackaged: true, getVersion: () => "0.1.0", getPath: () => temporary, quit: () => { quits += 1; } },
    dialog: { showMessageBox: async () => ({ response: 0 }) },
    shell: { openPath: async target => { opened = target; return ""; } },
    logger: { info() {}, warn() {}, error() {} },
    platform: "win32",
    fetchImpl: async () => request++ === 0
      ? response(null, { json: [release("0.2.0", [installer])] })
      : response(bytes, { url: "https://release-assets.githubusercontent.com/release.exe" }),
  });
  assert.equal(result.status, "installer-opened");
  assert.equal(opened, result.installerPath);
  assert.equal(quits, 1);
});

test("an unverifiable installer fails closed", async () => {
  let quits = 0;
  const installer = { ...asset("Phone-Farm-Windows.exe"), digest: null };
  const prompts = [];
  const result = await enforceReleaseVersion({
    app: { isPackaged: true, getVersion: () => "0.1.0", getPath: () => os.tmpdir(), quit: () => { quits += 1; } },
    dialog: { showMessageBox: async options => { prompts.push(options); return { response: prompts.length === 1 ? 0 : 1 }; } },
    shell: { openPath: async () => assert.fail("must not open") },
    logger: { info() {}, warn() {}, error() {} },
    platform: "win32",
    fetchImpl: async () => response(null, { json: [release("0.2.0", [installer])] }),
  });
  assert.equal(result.status, "error");
  assert.equal(quits, 1);
  assert.match(prompts[1].detail, /SHA-256 digest/);
});
