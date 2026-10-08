const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const desktopDir = path.resolve(__dirname, "..");
const read = file => fs.readFileSync(path.join(desktopDir, file), "utf8");

// The list of processes Bodun started must live in durable app storage on every
// kind of install (host, site agent), never inside the app bundle, where an
// update would wipe it.
test("the host server is given a process-ownership file under app storage", () => {
  const main = read("main.js");
  assert.match(main, /PROCESS_OWNERSHIP_PATH:\s*path\.join\(storageRoot,\s*"process-ownership\.json"\)/);
});

test("the site agent is given a process-ownership file under app storage", () => {
  const { siteAgentEnvironment } = require("../siteAgentConfig.js");
  const env = siteAgentEnvironment({ hubUrl: "https://phones.example.com", siteId: "bucharest", siteToken: "pfs_x" }, { storageRoot: "/store", path: path.posix });
  assert.equal(env.PROCESS_OWNERSHIP_PATH, "/store/process-ownership.json");
});

test("the packaged-runtime check boots the server with the same setting", () => {
  assert.match(read("scripts/verify-packaged-runtime.cjs"), /PROCESS_OWNERSHIP_PATH:\s*path\.join\(scratch,\s*"process-ownership\.json"\)/);
});
