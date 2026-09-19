// Runtime helpers for the WebDriverAgent that ships inside Phone Farm.app.
//
// The signed .app bundle is read-only at runtime: xcodebuild must never build
// inside it. On first launch the bundled, unmodified WDA source
// (Contents/Resources/wda/WebDriverAgent) is copied to a versioned folder under
// the user's Application Support directory; that writable copy is what the
// server is pointed at (derived data already lives outside the bundle too).
//
// Signing: an unsigned WDA project cannot run on a physical iPhone without a
// development team. detectDevelopmentTeams() reads Apple Development
// certificates from the login keychain (best effort, macOS only) so a host
// with exactly one team needs no input at all; otherwise the operator enters
// their 10-character Team ID once in host setup.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const TEAM_ID_PATTERN = /^[A-Z0-9]{10}$/;

function isValidTeamId(value) {
  return typeof value === "string" && TEAM_ID_PATTERN.test(value);
}

function readBundledWdaInfo(bundledRoot, fsImpl = fs) {
  try {
    const info = JSON.parse(fsImpl.readFileSync(path.join(bundledRoot, "WDA_VERSION.json"), "utf8"));
    if (typeof info.version !== "string" || !/^[0-9a-f]{40}$/.test(info.commit || "")) return null;
    return info;
  } catch {
    return null;
  }
}

function makeWritable(target, fsImpl) {
  // The bundle's files may be read-only; xcodebuild needs a writable tree.
  const stack = [target];
  while (stack.length) {
    const current = stack.pop();
    const stat = fsImpl.lstatSync(current);
    if (stat.isSymbolicLink()) continue;
    fsImpl.chmodSync(current, stat.mode | 0o200 | (stat.isDirectory() ? 0o100 : 0));
    if (stat.isDirectory()) for (const name of fsImpl.readdirSync(current)) stack.push(path.join(current, name));
  }
}

// Returns { path, version, commit } for the writable managed copy, or null when
// this build has no bundled WDA. Idempotent: a completed copy of the same
// version+commit is reused; an interrupted copy is discarded and redone.
function ensureManagedWdaSource({ bundledRoot, managedRoot, fsImpl = fs, log = () => {} }) {
  const info = readBundledWdaInfo(bundledRoot, fsImpl);
  if (!info) return null;
  const sourceDir = path.join(bundledRoot, "WebDriverAgent");
  if (!fsImpl.existsSync(path.join(sourceDir, "WebDriverAgent.xcodeproj"))) return null;

  const versionDir = path.join(managedRoot, `${info.version}-${info.commit.slice(0, 12)}`);
  const target = path.join(versionDir, "WebDriverAgent");
  const marker = path.join(versionDir, ".complete");
  const result = { path: target, version: info.version, commit: info.commit };

  if (fsImpl.existsSync(marker) && fsImpl.existsSync(path.join(target, "WebDriverAgent.xcodeproj"))) {
    return result;
  }
  const temporary = `${versionDir}.tmp-${process.pid}`;
  fsImpl.rmSync(temporary, { recursive: true, force: true });
  fsImpl.rmSync(versionDir, { recursive: true, force: true });
  fsImpl.mkdirSync(temporary, { recursive: true });
  fsImpl.cpSync(sourceDir, path.join(temporary, "WebDriverAgent"), { recursive: true });
  makeWritable(temporary, fsImpl);
  fsImpl.writeFileSync(path.join(temporary, ".complete"), `${JSON.stringify(info)}\n`);
  fsImpl.renameSync(temporary, versionDir);
  log(`WebDriverAgent ${info.tag || info.version} copied to ${target}`);

  // Best-effort cleanup of copies from older app versions.
  try {
    for (const entry of fsImpl.readdirSync(managedRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && path.join(managedRoot, entry.name) !== versionDir) {
        fsImpl.rmSync(path.join(managedRoot, entry.name), { recursive: true, force: true });
      }
    }
  } catch { /* leave stale copies rather than fail startup */ }
  return result;
}

// `openssl x509 -noout -subject -nameopt RFC2253` yields e.g.
//   subject=UID=ABC123DEFG,CN=Apple Development: Jane Doe (XYZ987WVUT),OU=TEAM123456,O=Jane Doe,C=US
// The team is the OU. (The 10-character id inside the CN is the certificate
// holder's personal id, NOT the team.)
function parseTeamIdsFromSubjects(text) {
  const teams = new Set();
  for (const match of String(text || "").matchAll(/(?:^|[=,/\s])OU=([A-Z0-9]{10})(?=[,/\s]|$)/gm)) teams.add(match[1]);
  return [...teams];
}

function detectDevelopmentTeams({
  platform = process.platform,
  execFile = execFileSync,
  securityBin = "/usr/bin/security",
  opensslBin = "/usr/bin/openssl",
} = {}) {
  if (platform !== "darwin") return [];
  const teams = new Set();
  for (const commonName of ["Apple Development", "iPhone Developer"]) {
    let pem = "";
    try {
      pem = String(execFile(securityBin, ["find-certificate", "-a", "-c", commonName, "-p"], {
        encoding: "utf8", timeout: 8000, maxBuffer: 8 * 1024 * 1024,
      }));
    } catch {
      continue; // no such certificates, or the keychain is locked: not an error
    }
    for (const block of pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || []) {
      try {
        const subject = String(execFile(opensslBin, ["x509", "-noout", "-subject", "-nameopt", "RFC2253"], {
          input: block, encoding: "utf8", timeout: 5000,
        }));
        for (const team of parseTeamIdsFromSubjects(subject)) teams.add(team);
      } catch { /* an unreadable certificate contributes no team */ }
    }
  }
  return [...teams].sort();
}

// Precedence: explicit environment > saved by the operator > the single
// detected team. Several detected teams are never guessed between.
function resolveWdaDevelopmentTeam({ env = process.env, savedTeam = null, detected = [] } = {}) {
  if (isValidTeamId(env.WDA_DEVELOPMENT_TEAM)) return { teamId: env.WDA_DEVELOPMENT_TEAM, source: "environment", candidates: [] };
  if (isValidTeamId(savedTeam)) return { teamId: savedTeam, source: "saved", candidates: [] };
  if (detected.length === 1) return { teamId: detected[0], source: "detected", candidates: detected };
  return { teamId: null, source: null, candidates: detected };
}

module.exports = {
  detectDevelopmentTeams,
  ensureManagedWdaSource,
  isValidTeamId,
  parseTeamIdsFromSubjects,
  readBundledWdaInfo,
  resolveWdaDevelopmentTeam,
};
