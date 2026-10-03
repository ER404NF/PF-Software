// Route contract for the device file-push link pair (docs/productionization/P4_DEVICE_PUSH_BUILD.md),
// in the same handler-level style as proxyPoolRoutes.test.js. The link store is the real one, on a
// temporary file, so single-use and expiry are the production guarantees rather than a stub's.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { registerFilePushRoutes } from "../../src/routes/filePushRoutes.js";
import { createFilePushLinkStore } from "../../src/filePushLinkStore.js";

const ACCESS_MEDIA = "media:access";
const SECRET_DIR = path.join(os.tmpdir(), "pf-private-device-storage-7f3a");
const FILE_PATH = path.join(SECRET_DIR, "device-a", "clip.mp4");
const ORIGIN = "https://hub.example";

function createApp() {
  const routes = new Map();
  const add = method => (route, handler) => routes.set(`${method} ${route}`, handler);
  return { app: { get: add("GET"), post: add("POST") }, routes };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    ended: false,
    downloaded: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { this.ended = true; return this; },
    download(file) { this.downloaded = file; return this; },
  };
}

function setup(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-file-push-routes-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const storePath = path.join(dir, "file-push-links.json");
  const filePushLinkStore = createFilePushLinkStore({ storePath });
  const { app, routes } = createApp();
  const audits = [];
  const files = new Map([["device-a/clip.mp4", FILE_PATH]]);
  const modes = new Map([["device-a", "HUMAN"], ["device-b", "AI_RUNNING"]]);
  registerFilePushRoutes({
    app,
    hasCapability: (operator, capability) => Boolean(operator?.capabilities?.includes(capability)),
    accessMediaCapability: ACCESS_MEDIA,
    knownDevice: id => id === "device-a" || id === "device-b",
    canAccessDevice: (operator, id) => operator.allowedDevices.includes(id),
    deviceMediaRepository: { resolveFile: (deviceId, filename) => files.get(`${deviceId}/${filename}`) ?? null },
    filePushLinkStore,
    auditLog: { logEvent: event => audits.push(event) },
    hubOrigin: () => ORIGIN,
    deviceLease: { getMode: id => modes.get(id) },
    devices: new Map(),
    currentStoredOperator: async req => req.currentOperator,
    ...overrides,
  });
  return { routes, audits, files, storePath, filePushLinkStore };
}

const va = (allowedDevices = ["device-a"], capabilities = [ACCESS_MEDIA]) => ({ username: "va-1", allowedDevices, capabilities });
const issueRequest = (operator, params = {}) => ({ params: { deviceId: "device-a", filename: "clip.mp4", ...params }, currentOperator: operator });
const tokenOf = url => url.slice(`${ORIGIN}/d/`.length);

function issue(routes, operator, params) {
  const res = response();
  routes.get("POST /api/devices/:deviceId/files/:filename/push-link")(issueRequest(operator, params), res);
  return res;
}

function fetchLink(routes, token) {
  const res = response();
  routes.get("GET /d/:token")({ params: { token } }, res);
  return res;
}

// Everything a caller or an operator could ever see: response bodies, audit events, console output.
function captureConsole(t) {
  const lines = [];
  for (const method of ["log", "info", "warn", "error", "debug"]) {
    t.mock.method(console, method, (...args) => { lines.push(args.map(String).join(" ")); });
  }
  return lines;
}

test("registers exactly the file-push route family", t => {
  const { routes } = setup(t);
  assert.deepEqual([...routes.keys()], [
    "POST /api/devices/:deviceId/files/:filename/push-link",
    "GET /d/:token",
    "POST /api/devices/:deviceId/files/:filename/push",
  ]);
});

test("issuance is capability-gated: no session, or no media capability, issues nothing", t => {
  const { routes, audits, storePath } = setup(t);
  for (const operator of [undefined, va(["device-a"], [])]) {
    const res = issue(routes, operator);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.url, undefined);
  }
  assert.equal(fs.existsSync(storePath), false, "a refused request must not create a token record");
  assert.deepEqual(audits, []);
});

test("issuance is device-scoped: unknown device, another operator's device and unknown file issue nothing", t => {
  const { routes, audits, storePath } = setup(t);
  assert.equal(issue(routes, va(), { deviceId: "device-z" }).statusCode, 404);
  assert.equal(issue(routes, va(["device-b"])).statusCode, 403);
  assert.equal(issue(routes, va(), { filename: "../../etc/passwd" }).statusCode, 404);
  assert.equal(issue(routes, va(), { filename: "missing.mp4" }).statusCode, 404);
  assert.equal(fs.existsSync(storePath), false);
  assert.deepEqual(audits, []);
});

test("an issued link is a random single-use token; only its hash is stored", t => {
  const { routes, audits, storePath } = setup(t);
  const first = issue(routes, va());
  const second = issue(routes, va());
  assert.equal(first.statusCode, 200);
  assert.match(first.body.url, /^https:\/\/hub\.example\/d\/pfl_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first.body.url, second.body.url);
  const expiresIn = Date.parse(first.body.expiresAt) - Date.now();
  assert.ok(expiresIn > 4 * 60_000 && expiresIn <= 10 * 60_000, "short-lived: 5-10 minutes");
  const stored = fs.readFileSync(storePath, "utf8");
  assert.ok(!stored.includes(tokenOf(first.body.url)), "the raw token is never persisted");
  assert.deepEqual(Object.keys(first.body).sort(), ["expiresAt", "url"]);
  assert.equal(audits[0].type, "file_push_link_issued");
  assert.deepEqual(Object.keys(audits[0].detail).sort(), ["expiresAt", "name"]);
});

test("SINGLE USE: the same token serves the file once and is refused on every later request", t => {
  const { routes, audits } = setup(t);
  const token = tokenOf(issue(routes, va()).body.url);

  const firstUse = fetchLink(routes, token);
  assert.equal(firstUse.statusCode, 200);
  assert.equal(firstUse.downloaded, FILE_PATH);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const replay = fetchLink(routes, token);
    assert.equal(replay.statusCode, 404, `replay ${attempt + 1} must fail closed`);
    assert.equal(replay.downloaded, null, `replay ${attempt + 1} must not re-serve the file`);
    assert.equal(replay.body, null);
  }
  assert.equal(audits.filter(event => event.type === "file_push_link_consumed").length, 1);
});

test("SINGLE USE under concurrency: simultaneous requests for one token serve the file exactly once", async t => {
  const { routes } = setup(t);
  const token = tokenOf(issue(routes, va()).body.url);
  const results = await Promise.all(Array.from({ length: 8 }, () => Promise.resolve().then(() => fetchLink(routes, token))));
  assert.equal(results.filter(res => res.downloaded).length, 1);
  assert.equal(results.filter(res => res.statusCode === 404 && !res.downloaded).length, 7);
});

test("a token is consumed even when its file has since been deleted, and stays dead", t => {
  const { routes, files, audits } = setup(t);
  const token = tokenOf(issue(routes, va()).body.url);
  files.delete("device-a/clip.mp4");
  assert.equal(fetchLink(routes, token).statusCode, 404);
  files.set("device-a/clip.mp4", FILE_PATH);
  const retry = fetchLink(routes, token);
  assert.equal(retry.statusCode, 404);
  assert.equal(retry.downloaded, null);
  assert.equal(audits.at(-1).detail.resolved, false);
});

test("an expired token is refused and serves nothing", t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-03T12:00:00.000Z") });
  const { routes, audits } = setup(t);
  const token = tokenOf(issue(routes, va()).body.url);
  t.mock.timers.tick(10 * 60_000 + 1);
  const late = fetchLink(routes, token);
  assert.equal(late.statusCode, 404);
  assert.equal(late.downloaded, null);
  assert.equal(audits.filter(event => event.type === "file_push_link_consumed").length, 0);
});

test("unknown, malformed and oversized tokens are refused without touching any file", t => {
  const { routes } = setup(t);
  issue(routes, va());
  for (const token of ["", "pfl_", "pfl_unknown", "not-a-link", `pfl_${"a".repeat(500)}`, "../clip.mp4"]) {
    const res = fetchLink(routes, token);
    assert.equal(res.statusCode, 404);
    assert.equal(res.downloaded, null);
  }
});

test("the push trigger refuses a device that is not in Human VA mode, without revealing it to others", async t => {
  const { routes, storePath } = setup(t);
  const push = routes.get("POST /api/devices/:deviceId/files/:filename/push");
  const aiOwned = response();
  await push(issueRequest(va(["device-b"]), { deviceId: "device-b" }), aiOwned);
  assert.equal(aiOwned.statusCode, 409);
  const outsider = response();
  await push(issueRequest(va(["device-a"]), { deviceId: "device-b" }), outsider);
  assert.equal(outsider.statusCode, 403, "an operator without access learns nothing about the controller mode");
  assert.equal(fs.existsSync(storePath), false);
});

test("no response, audit event or console line ever contains the file path, storage folder, raw token or its hash", t => {
  const consoleLines = captureConsole(t);
  const { routes, audits, files, storePath } = setup(t);
  const visible = [];
  const keep = res => { visible.push(JSON.stringify({ status: res.statusCode, body: res.body })); return res; };

  keep(issue(routes, undefined));
  keep(issue(routes, va(["device-b"])));
  keep(issue(routes, va(), { filename: "missing.mp4" }));
  const issued = issue(routes, va());
  const token = tokenOf(issued.body.url);
  const hash = JSON.parse(fs.readFileSync(storePath, "utf8")).links[0].tokenHash;
  keep(fetchLink(routes, token));
  keep(fetchLink(routes, token));
  keep(fetchLink(routes, "pfl_bogus"));
  const second = tokenOf(issue(routes, va()).body.url);
  files.clear();
  keep(fetchLink(routes, second));

  const everything = [...visible, ...audits.map(event => JSON.stringify(event)), ...consoleLines].join("\n");
  for (const secret of [FILE_PATH, SECRET_DIR, path.basename(SECRET_DIR), token, second, hash]) {
    assert.ok(!everything.includes(secret), `leaked: ${secret === token || secret === second ? "raw token" : secret === hash ? "token hash" : "file path"}`);
  }
  // The issuing operator legitimately receives the link itself - and nothing else.
  assert.ok(!JSON.stringify(issued.body).includes(SECRET_DIR));
});
