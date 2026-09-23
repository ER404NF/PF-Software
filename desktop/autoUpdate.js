const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const RELEASES_API = "https://api.github.com/repos/ER404NF/PF-Software/releases?per_page=30";
const MAX_INSTALLER_BYTES = 1024 * 1024 * 1024;
const TRUSTED_DOWNLOAD_HOSTS = new Set([
  "github.com",
  "api.github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);

function normalizedVersion(value) {
  const match = String(value || "").trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return {
    text: `${match[1]}.${match[2]}.${match[3]}${match[4] ? `-${match[4]}` : ""}`,
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] || null,
  };
}

function compareVersions(left, right) {
  const a = typeof left === "string" ? normalizedVersion(left) : left;
  const b = typeof right === "string" ? normalizedVersion(right) : right;
  if (!a || !b) throw new Error("Cannot compare an invalid application version.");
  for (let index = 0; index < 3; index += 1) {
    if (a.parts[index] !== b.parts[index]) return a.parts[index] - b.parts[index];
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease, "en", { numeric: true });
}

function selectRelease(releases) {
  const eligible = Array.isArray(releases)
    ? releases.filter(release => !release?.draft && !release?.prerelease && normalizedVersion(release?.tag_name))
    : [];
  return eligible.sort((left, right) => compareVersions(right.tag_name, left.tag_name))[0] || null;
}

function installerCandidates({ platform, arch, version }) {
  if (platform === "win32") {
    return [
      "Phone-Farm-Windows.exe",
      `Phone-Farm-Setup-${version}.exe`,
      `Phone Farm Setup ${version}.exe`,
    ];
  }
  if (platform === "darwin") {
    const preferredArch = arch === "x64" ? "universal" : "arm64";
    const variants = ["", "-NOT-NOTARIZED", "-UNSIGNED"];
    const versioned = variants.map(suffix => `Phone-Farm-${version}-${preferredArch}${suffix}.pkg`);
    return arch === "x64"
      ? versioned
      : ["Phone-Farm-macOS.pkg", ...versioned, ...variants.map(suffix => `Phone-Farm-${version}-universal${suffix}.pkg`)];
  }
  return [];
}

function selectInstallerAsset(release, platform = process.platform, arch = process.arch) {
  const version = normalizedVersion(release?.tag_name)?.text;
  if (!version || !Array.isArray(release?.assets)) return null;
  const assets = new Map(release.assets.map(asset => [asset?.name, asset]));
  for (const name of installerCandidates({ platform, arch, version })) {
    const asset = assets.get(name);
    if (asset) return asset;
  }
  return null;
}

function trustedHttpsUrl(rawUrl) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch { return null; }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || !TRUSTED_DOWNLOAD_HOSTS.has(parsed.hostname)) return null;
  return parsed;
}

async function fetchReleases({ fetchImpl = fetch, apiUrl = RELEASES_API, timeoutMs = 15_000 } = {}) {
  const trusted = trustedHttpsUrl(apiUrl);
  if (!trusted || trusted.hostname !== "api.github.com") throw new Error("The release service URL is not trusted.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(trusted, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "Phone-Farm-Desktop" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`The release service returned HTTP ${response.status}.`);
    const releases = await response.json();
    if (!Array.isArray(releases)) throw new Error("The release service returned an invalid response.");
    return releases;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("The release check timed out.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function expectedDigest(asset) {
  const match = String(asset?.digest || "").match(/^sha256:([a-fA-F0-9]{64})$/);
  return match?.[1].toLowerCase() || null;
}

async function downloadInstaller(asset, destinationDir, { fetchImpl = fetch, maxBytes = MAX_INSTALLER_BYTES, timeoutMs = 120_000 } = {}) {
  const url = trustedHttpsUrl(asset?.browser_download_url);
  const digest = expectedDigest(asset);
  if (!url || url.hostname !== "github.com") throw new Error("The installer download URL is not trusted.");
  if (!digest) throw new Error("GitHub did not provide a SHA-256 digest for this installer.");
  if (!Number.isSafeInteger(asset?.size) || asset.size <= 0 || asset.size > maxBytes) {
    throw new Error("The installer has an invalid or unsafe download size.");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]*\.(?:pkg|exe)$/.test(asset.name)) throw new Error("The installer filename is invalid.");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: "application/octet-stream", "User-Agent": "Phone-Farm-Desktop" },
      redirect: "follow",
      signal: controller.signal,
    });
    const finalUrl = trustedHttpsUrl(response.url || url.toString());
    if (!response.ok || !response.body) throw new Error(`The installer download failed with HTTP ${response.status}.`);
    if (!finalUrl) throw new Error("The installer download redirected to an untrusted service.");

    await fs.promises.mkdir(destinationDir, { recursive: true });
    const destination = path.join(destinationDir, asset.name);
    const temporary = `${destination}.download`;
    const hash = crypto.createHash("sha256");
    let total = 0;
    const file = await fs.promises.open(temporary, "w", 0o600);
    try {
      for await (const value of response.body) {
        const chunk = Buffer.from(value);
        total += chunk.length;
        if (total > maxBytes || total > asset.size) throw new Error("The installer download exceeded its declared size.");
        hash.update(chunk);
        await file.write(chunk);
      }
      await file.close();
    } catch (error) {
      await file.close().catch(() => {});
      await fs.promises.rm(temporary, { force: true });
      throw error;
    }
    if (total !== asset.size) {
      await fs.promises.rm(temporary, { force: true });
      throw new Error("The installer download was incomplete.");
    }
    const actual = hash.digest("hex");
    if (!crypto.timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(digest, "hex"))) {
      await fs.promises.rm(temporary, { force: true });
      throw new Error("The installer failed SHA-256 verification.");
    }
    await fs.promises.rm(destination, { force: true });
    await fs.promises.rename(temporary, destination);
    return destination;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("The installer download timed out.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function retryOrExit(dialog, error) {
  const result = await dialog.showMessageBox({
    type: "error",
    title: "Phone Farm update required",
    message: "Phone Farm could not verify or install the required version.",
    detail: `${error.message}\n\nPhone Farm will remain closed until the update succeeds.`,
    buttons: ["Retry", "Exit"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  return result?.response === 0;
}

async function enforceReleaseVersion({
  app,
  dialog,
  shell,
  logger = console,
  platform = process.platform,
  arch = process.arch,
  fetchImpl = fetch,
  apiUrl = RELEASES_API,
} = {}) {
  if (!app?.isPackaged) return { allowed: true, status: "development" };
  for (;;) {
    try {
      const current = normalizedVersion(app.getVersion());
      if (!current) throw new Error("This installation has an invalid application version.");
      const release = selectRelease(await fetchReleases({ fetchImpl, apiUrl }));
      if (!release) throw new Error("No published Phone Farm release is available.");
      const available = normalizedVersion(release.tag_name);
      if (compareVersions(current, available) === 0) return { allowed: true, status: "current", version: current.text };

      const asset = selectInstallerAsset(release, platform, arch);
      if (!asset) throw new Error(`Phone Farm ${available.text} has no installer for this computer yet.`);
      const answer = await dialog.showMessageBox({
        type: "warning",
        title: "Phone Farm update required",
        message: `Phone Farm ${available.text} is required`,
        detail: `This computer has Phone Farm ${current.text}. It cannot continue until the versions match.`,
        buttons: ["Update now", "No — exit"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (answer?.response !== 0) {
        logger.warn(`update from ${current.text} to ${available.text} declined; exiting`);
        app.quit();
        return { allowed: false, status: "declined" };
      }

      const updateDir = await fs.promises.mkdtemp(path.join(app.getPath("temp"), "phone-farm-update-"));
      const installerPath = await downloadInstaller(asset, updateDir, { fetchImpl });
      const openError = await shell.openPath(installerPath);
      if (openError) throw new Error(`The installer could not be opened: ${openError}`);
      logger.info(`verified Phone Farm ${available.text} installer and opened it`);
      app.quit();
      return { allowed: false, status: "installer-opened", installerPath };
    } catch (error) {
      logger.error(`update gate: ${error?.stack || error}`);
      if (await retryOrExit(dialog, error)) continue;
      app.quit();
      return { allowed: false, status: "error", error: error.message };
    }
  }
}

module.exports = {
  MAX_INSTALLER_BYTES,
  RELEASES_API,
  compareVersions,
  downloadInstaller,
  enforceReleaseVersion,
  expectedDigest,
  fetchReleases,
  installerCandidates,
  normalizedVersion,
  selectInstallerAsset,
  selectRelease,
  trustedHttpsUrl,
};
