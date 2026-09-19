// Verifies a Phone Farm resources directory — the staged build/runtime tree
// during a build, or Phone Farm.app/Contents/Resources of a finished app —
// without needing the source repository:
//
//   1. every file the desktop host needs is present (server entry, web
//      client, production node_modules, bundled WebDriverAgent when required);
//   2. every bare `import`/`require` in system/server/src resolves inside the
//      packaged node_modules (so no dependency is silently missing);
//   3. nothing that must never ship is present (operator accounts, device
//      config, runtime storage, tests, fixtures, key material);
//   4. optionally, the real server boots from that directory with the given
//      Node-compatible executable (Electron with ELECTRON_RUN_AS_NODE=1 in
//      the app), serves the web client, answers the API, and leaves the
//      resources tree byte-for-byte unmodified (a signed bundle must never be
//      written to at runtime).
//
//   node verify-packaged-runtime.cjs <resourcesDir> [nodeExecutable] [--no-boot] [--require-wda]

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { builtinModules } = require("module");
const { spawn } = require("child_process");

const FORBIDDEN_FILE_NAMES = new Set([
  "operators.config.json", "devices.config.json", ".env", ".env.local", "credentials.json", "id_rsa", "id_ed25519",
]);
const FORBIDDEN_DIR_NAMES = new Set(["storage", "tmp", "test", "fixtures", ".git"]);
const FORBIDDEN_EXTENSIONS = [".pem", ".p12", ".p8", ".pfx", ".key", ".keychain", ".mobileprovision"];
const BUILTINS = new Set([...builtinModules, ...builtinModules.map(name => `node:${name}`)]);

function* walk(dir, { skipDir = () => false } = {}) {
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!skipDir(target, entry.name)) stack.push(target);
      } else {
        yield target;
      }
    }
  }
}

// Every local script, stylesheet, icon and manifest the web client's own page points at must be in the package:
// a missing app.js or review.js would give operators a blank or half-working page that no server test would notice.
function clientAssetFiles(clientDir) {
  const indexFile = path.join(clientDir, "index.html");
  if (!fs.existsSync(indexFile)) return [];
  const files = new Set();
  const html = fs.readFileSync(indexFile, "utf8");
  for (const match of html.matchAll(/\b(?:src|href)=["']([^"'#?]+)["']/g)) {
    const reference = match[1].trim();
    if (!reference || /^([a-z][a-z0-9+.-]*:)?\/\//i.test(reference) || /^(data|mailto|javascript):/i.test(reference)) continue;
    files.add(path.join(clientDir, reference.replace(/^\//, "")));
  }
  const manifest = path.join(clientDir, "manifest.webmanifest");
  if (fs.existsSync(manifest)) {
    try {
      for (const icon of JSON.parse(fs.readFileSync(manifest, "utf8")).icons ?? []) {
        if (typeof icon?.src === "string" && !/^([a-z][a-z0-9+.-]*:)?\/\//i.test(icon.src)) files.add(path.join(clientDir, icon.src.replace(/^\//, "")));
      }
    } catch { /* an unreadable manifest is reported by the web-app tests, not here */ }
  }
  return [...files];
}

function requiredFiles(resourcesDir, { requireWda = false } = {}) {
  const system = path.join(resourcesDir, "system");
  const packageJson = JSON.parse(fs.readFileSync(path.join(system, "package.json"), "utf8"));
  const files = [
    path.join(system, "server", "src", "index.js"),
    path.join(system, "server", "src", "agentMain.js"),
    path.join(system, "client", "index.html"),
    path.join(system, "client", "phoneStage.js"),
    path.join(system, "client", "app.js"),
    path.join(system, "package.json"),
    path.join(system, "package-lock.json"),
    ...Object.keys(packageJson.dependencies || {}).map(name => path.join(system, "node_modules", name, "package.json")),
    ...clientAssetFiles(path.join(system, "client")),
  ];
  if (requireWda) {
    files.push(
      path.join(resourcesDir, "wda", "WDA_VERSION.json"),
      path.join(resourcesDir, "wda", "WebDriverAgent", "WebDriverAgent.xcodeproj", "project.pbxproj"),
      path.join(resourcesDir, "wda", "WebDriverAgent", "LICENSE"),
      path.join(resourcesDir, "licenses", "WebDriverAgent-LICENSE.txt"),
    );
  }
  return files;
}

function findMissingFiles(resourcesDir, options) {
  return requiredFiles(resourcesDir, options).filter(file => !fs.existsSync(file));
}

function bareSpecifiers(source) {
  const found = new Set();
  const patterns = [
    /^\s*(?:import|export)\s[^"'`\n]*?from\s*["']([^"']+)["']/gm,
    /^\s*import\s*["']([^"']+)["']/gm,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier.startsWith(".") || specifier.startsWith("/") || BUILTINS.has(specifier)) continue;
      const parts = specifier.split("/");
      found.add(specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]);
    }
  }
  return found;
}

function findUnresolvableImports(resourcesDir) {
  const system = path.join(resourcesDir, "system");
  const unresolved = [];
  for (const file of walk(path.join(system, "server", "src"))) {
    if (!file.endsWith(".js")) continue;
    for (const name of bareSpecifiers(fs.readFileSync(file, "utf8"))) {
      if (!fs.existsSync(path.join(system, "node_modules", name, "package.json"))) {
        unresolved.push(`${path.relative(system, file)} imports "${name}" which is not in the packaged node_modules`);
      }
    }
  }
  return unresolved;
}

function findForbiddenFiles(resourcesDir) {
  const system = path.join(resourcesDir, "system");
  const violations = [];
  const isNodeModules = target => target.split(path.sep).includes("node_modules");
  for (const file of walk(system, { skipDir: (target, name) => name === "node_modules" })) {
    const relative = path.relative(system, file);
    const name = path.basename(file);
    if (FORBIDDEN_FILE_NAMES.has(name)) violations.push(relative);
    else if (FORBIDDEN_EXTENSIONS.some(ext => name.toLowerCase().endsWith(ext))) violations.push(relative);
    else if (/^test-.*\.txt$/.test(name)) violations.push(relative);
    else if (relative.split(path.sep).some(part => FORBIDDEN_DIR_NAMES.has(part)) && !isNodeModules(file)) violations.push(relative);
  }
  // Empty forbidden directories still indicate a leaky staging step.
  for (const name of FORBIDDEN_DIR_NAMES) {
    for (const base of [system, path.join(system, "server")]) {
      if (fs.existsSync(path.join(base, name))) violations.push(path.relative(system, path.join(base, name)) + path.sep);
    }
  }
  return [...new Set(violations)];
}

function treeFingerprint(dir) {
  const hash = crypto.createHash("sha256");
  let count = 0;
  const files = [...walk(dir)].sort();
  for (const file of files) {
    const stat = fs.statSync(file);
    hash.update(`${path.relative(dir, file)}\0${stat.size}\0${Math.trunc(stat.mtimeMs)}\n`);
    count += 1;
  }
  return { digest: hash.digest("hex"), count };
}

function httpStatus(port, urlPath) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port, path: urlPath, timeout: 5000 }, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { if (body.length < 4096) body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body }));
    });
    request.on("error", reject);
    request.on("timeout", () => request.destroy(new Error("request timed out")));
  });
}

async function bootAndProbe(resourcesDir, nodeExecutable, { timeoutMs = 30_000 } = {}) {
  const system = path.join(resourcesDir, "system");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-verify-"));
  const before = treeFingerprint(resourcesDir);
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    PORT: "0",
    HOST: "127.0.0.1",
    SESSION_SECRET: crypto.randomBytes(32).toString("hex"),
    TWO_FACTOR_MASTER_KEY: crypto.randomBytes(32).toString("hex"),
    DESKTOP_AUTO_DEVICE_MODE: "true",
    AUTO_DISCOVER_IOS_DEVICES: "false",
    OPERATORS_CONFIG_PATH: path.join(scratch, "operators.json"),
    SESSION_STORE_DIR: path.join(scratch, "sessions"),
    AUDIT_LOG_PATH: path.join(scratch, "audit.log"),
    QUEUE_STORE_PATH: path.join(scratch, "queue.json"),
    MODEL_SELECTION_STORE_PATH: path.join(scratch, "models.json"),
    ASSIGNMENT_STORE_PATH: path.join(scratch, "assignments.json"),
    RESEARCH_STORE_DIR: path.join(scratch, "research"),
    RESEARCH_EVIDENCE_DIR: path.join(scratch, "evidence"),
    FILE_STORE_DIR: path.join(scratch, "files"),
    ACCOUNT_NOTIFICATION_STORE_PATH: path.join(scratch, "notifications.json"),
    DEVICE_PROVISIONING_STORE_PATH: path.join(scratch, "device-provisioning.json"),
    WDA_DERIVED_DATA_ROOT: path.join(scratch, "wda-derived-data"),
    PROXY_POOL_STORE_PATH: path.join(scratch, "proxy-pool.json"),
    USB_NETWORK_STORE_PATH: path.join(scratch, "usb-network.json"),
  };
  delete env.DEVICE_CONFIG_PATH;
  const child = spawn(nodeExecutable, [path.join(system, "server", "src", "index.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let exited = null;
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  child.on("exit", code => { exited = code; });
  const failures = [];
  let port = null;
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && port === null && exited === null) {
      const match = /running at http:\/\/[^:]+:(\d+)/.exec(output);
      if (match) port = Number(match[1]);
      else await new Promise(resolve => setTimeout(resolve, 150));
    }
    if (port === null) {
      const hint = exited === 0
        ? "\nThe server exited normally without listening: it probably decided it was imported rather than run (see server/src/directExecution.js; a symlinked folder such as macOS /var -> /private/var used to cause this)."
        : "";
      failures.push(`server did not report a listening port (exit=${exited}).${hint} Output:\n${output.slice(-1500)}`);
    } else {
      const me = await httpStatus(port, "/api/me");
      if (me.status !== 401) failures.push(`GET /api/me returned ${me.status}, expected 401 for an unauthenticated request`);
      const index = await httpStatus(port, "/");
      if (index.status !== 200 || !/<html/i.test(index.body)) failures.push(`GET / did not serve the web client (status ${index.status})`);
    }
  } catch (error) {
    failures.push(`probe failed: ${error.message}`);
  } finally {
    child.kill();
    await new Promise(resolve => (exited !== null ? resolve() : child.once("exit", resolve)));
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  const after = treeFingerprint(resourcesDir);
  if (before.digest !== after.digest) {
    failures.push(`the packaged resources changed while the server ran (${before.count} -> ${after.count} files or different sizes/mtimes); a signed app bundle must never be written to at runtime`);
  }
  return failures;
}

async function verifyPackagedRuntime(resourcesDir, { nodeExecutable = null, boot = true, requireWda = false } = {}) {
  const failures = [];
  const missing = findMissingFiles(resourcesDir, { requireWda });
  for (const file of missing) failures.push(`missing: ${path.relative(resourcesDir, file)}`);
  if (missing.length === 0) {
    failures.push(...findUnresolvableImports(resourcesDir));
    for (const file of findForbiddenFiles(resourcesDir)) failures.push(`forbidden content shipped: system/${file}`);
    if (boot) {
      if (!nodeExecutable) failures.push("a Node-compatible executable is required to boot the packaged runtime");
      else failures.push(...await bootAndProbe(resourcesDir, nodeExecutable));
    }
  }
  return failures;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter(arg => arg.startsWith("--")));
  const [resourcesDir, nodeExecutable] = args.filter(arg => !arg.startsWith("--"));
  if (!resourcesDir) {
    console.error("usage: verify-packaged-runtime.cjs <resourcesDir> [nodeExecutable] [--no-boot] [--require-wda]");
    process.exit(2);
  }
  verifyPackagedRuntime(path.resolve(resourcesDir), {
    nodeExecutable: nodeExecutable ? path.resolve(nodeExecutable) : process.execPath,
    boot: !flags.has("--no-boot"),
    requireWda: flags.has("--require-wda"),
  }).then(failures => {
    if (failures.length) {
      for (const failure of failures) console.error(`FAIL  ${failure}`);
      process.exit(1);
    }
    console.log(`OK    packaged runtime verified: ${path.resolve(resourcesDir)}`);
  });
}

module.exports = {
  bareSpecifiers,
  bootAndProbe,
  clientAssetFiles,
  findForbiddenFiles,
  findMissingFiles,
  findUnresolvableImports,
  treeFingerprint,
  verifyPackagedRuntime,
};
