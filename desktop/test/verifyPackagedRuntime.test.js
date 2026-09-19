const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  bareSpecifiers,
  findForbiddenFiles,
  findMissingFiles,
  findUnresolvableImports,
  verifyPackagedRuntime,
} = require("../scripts/verify-packaged-runtime.cjs");

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pf-verify-test-"));
}

function writeFile(root, relative, content = "x") {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

// A minimal but real resources tree with a tiny HTTP server as system/server/src/index.js.
const FAKE_SERVER = `
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const server = http.createServer((req, res) => {
  if (req.url === "/api/me") { res.statusCode = 401; return res.end("{}"); }
  res.setHeader("content-type", "text/html");
  res.end(fs.readFileSync(path.join(here, "../../client/index.html")));
});
server.listen(Number(process.env.PORT) || 0, "127.0.0.1", () => {
  console.log("Phone Farm control server running at http://127.0.0.1:" + server.address().port);
  if (process.env.__TEST_WRITE_INTO_BUNDLE) fs.writeFileSync(path.join(here, "leaked.txt"), "written at runtime");
});
`;

function fakeResources(root, { wda = false } = {}) {
  writeFile(root, "system/package.json", JSON.stringify({ name: "fake", type: "module", dependencies: { express: "1.0.0" } }));
  writeFile(root, "system/package-lock.json", "{}");
  writeFile(root, "system/client/index.html", "<html><body>Phone Farm</body></html>");
  writeFile(root, "system/client/app.js", "//");
  writeFile(root, "system/client/phoneStage.js", "//");
  writeFile(root, "system/server/src/agentMain.js", "//");
  writeFile(root, "system/server/src/index.js", FAKE_SERVER);
  writeFile(root, "system/node_modules/express/package.json", '{"name":"express"}');
  if (wda) {
    writeFile(root, "wda/WDA_VERSION.json", "{}");
    writeFile(root, "wda/WebDriverAgent/WebDriverAgent.xcodeproj/project.pbxproj", "//");
    writeFile(root, "wda/WebDriverAgent/LICENSE", "BSD");
    writeFile(root, "licenses/WebDriverAgent-LICENSE.txt", "BSD");
  }
}

test("bare imports are found across static, dynamic and require forms; builtins and relative paths are ignored", () => {
  const source = `
    import express from "express";
    import { WebSocketServer } from "ws";
    import path from "path";
    import fs from "node:fs";
    import local from "./local.js";
    export { thing } from "@scope/pkg/sub";
    const later = await import("multer");
    const legacy = require("nodemailer");
    // import commented from "not-a-real-import";
  `;
  assert.deepEqual([...bareSpecifiers(source)].sort(), ["@scope/pkg", "express", "multer", "nodemailer", "ws"]);
});

test("a complete tree passes the static checks", async () => {
  const root = scratch();
  try {
    fakeResources(root, { wda: true });
    assert.deepEqual(findMissingFiles(root, { requireWda: true }), []);
    assert.deepEqual(findUnresolvableImports(root), []);
    assert.deepEqual(findForbiddenFiles(root), []);
    assert.deepEqual(await verifyPackagedRuntime(root, { boot: false, requireWda: true }), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a missing production dependency, server entry or WDA is reported", async () => {
  const root = scratch();
  try {
    fakeResources(root);
    fs.rmSync(path.join(root, "system", "node_modules"), { recursive: true });
    const failures = await verifyPackagedRuntime(root, { boot: false });
    assert.ok(failures.some(failure => /node_modules[\\/]express/.test(failure)));
    const withWda = await verifyPackagedRuntime(root, { boot: false, requireWda: true });
    assert.ok(withWda.some(failure => /wda/.test(failure)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an import that has no packaged module is reported by file", async () => {
  const root = scratch();
  try {
    fakeResources(root);
    writeFile(root, "system/server/src/extra.js", 'import thing from "not-packaged";\n');
    const failures = await verifyPackagedRuntime(root, { boot: false });
    assert.ok(failures.some(failure => failure.includes("extra.js") && failure.includes("not-packaged")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("operator accounts, device config, runtime storage, tests and key material are forbidden in a package", async () => {
  const root = scratch();
  try {
    fakeResources(root);
    for (const leaked of [
      "system/operators.config.json", "system/devices.config.json", "system/storage/sessions/s.json", "system/tmp/x",
      "system/server/test/a.test.js", "system/server/fixtures/f.js", "system/.env", "system/server/signing.p12", "system/test-results.txt",
    ]) writeFile(root, leaked);
    const found = findForbiddenFiles(root).map(item => item.replaceAll("\\", "/"));
    for (const expected of ["operators.config.json", "devices.config.json", "storage", ".env", "server/signing.p12", "test-results.txt"]) {
      assert.ok(found.some(item => item.includes(expected)), `expected ${expected} to be flagged, got ${found.join(", ")}`);
    }
    const failures = await verifyPackagedRuntime(root, { boot: false });
    assert.ok(failures.some(failure => failure.startsWith("forbidden content shipped")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("test directories inside node_modules are not mistaken for shipped tests", () => {
  const root = scratch();
  try {
    fakeResources(root);
    writeFile(root, "system/node_modules/express/test/x.js");
    assert.deepEqual(findForbiddenFiles(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the packaged server is actually booted, serves the client, and leaves the bundle untouched", async () => {
  const root = scratch();
  try {
    fakeResources(root);
    assert.deepEqual(await verifyPackagedRuntime(root, { nodeExecutable: process.execPath }), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a server that writes into its own (signed) bundle at runtime fails verification", async () => {
  const root = scratch();
  const previous = process.env.__TEST_WRITE_INTO_BUNDLE;
  process.env.__TEST_WRITE_INTO_BUNDLE = "1";
  try {
    fakeResources(root);
    const failures = await verifyPackagedRuntime(root, { nodeExecutable: process.execPath });
    assert.ok(failures.some(failure => /written to at runtime/.test(failure)), failures.join("\n"));
  } finally {
    if (previous === undefined) delete process.env.__TEST_WRITE_INTO_BUNDLE; else process.env.__TEST_WRITE_INTO_BUNDLE = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a server that fails to start is reported with its output", async () => {
  const root = scratch();
  try {
    fakeResources(root);
    writeFile(root, "system/server/src/index.js", 'throw new Error("boom: cannot start");\n');
    const failures = await verifyPackagedRuntime(root, { nodeExecutable: process.execPath });
    assert.ok(failures.some(failure => /did not report a listening port/.test(failure) && /boom: cannot start/.test(failure)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("every local script, stylesheet, icon and manifest icon the web client's page names is required in the package", () => {
  const { clientAssetFiles } = require("../scripts/verify-packaged-runtime.cjs");
  const client = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-client-"));
  try {
    fs.writeFileSync(path.join(client, "index.html"), [
      '<link rel="stylesheet" href="style.css">', '<link rel="manifest" href="/manifest.webmanifest">',
      '<script src="app.js"></script><script src="review.js"></script>',
      '<script src="https://cdn.example.com/lib.js"></script><script src="//cdn.example.com/other.js"></script>',
      '<a href="#top">top</a><a href="mailto:x@example.com">mail</a><img src="data:image/png;base64,AAAA">',
    ].join("\n"));
    fs.writeFileSync(path.join(client, "manifest.webmanifest"), JSON.stringify({ icons: [{ src: "/icons/icon-192.png" }, { src: "https://cdn.example.com/x.png" }] }));
    const relative = clientAssetFiles(client).map(file => path.relative(client, file).split(path.sep).join("/")).sort();
    assert.deepEqual(relative, ["app.js", "icons/icon-192.png", "manifest.webmanifest", "review.js", "style.css"]);
    assert.deepEqual(clientAssetFiles(path.join(client, "nowhere")), []);
  } finally {
    fs.rmSync(client, { recursive: true, force: true });
  }
});
