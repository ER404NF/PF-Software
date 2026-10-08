import fs from "node:fs";

// Reads the build record the installer writes next to the server (system/build-info.json). Missing or unreadable
// means this is not an installed build (a development run), which is a normal, supported state.
export function loadBuildInfo(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const commit = typeof raw.commit === "string" && /^([0-9a-f]{7,40}|unknown)$/i.test(raw.commit) ? raw.commit.toLowerCase() : null;
    const builtAt = typeof raw.builtAt === "string" && !Number.isNaN(Date.parse(raw.builtAt)) ? new Date(raw.builtAt).toISOString() : null;
    if (!commit) return { buildId: null, builtAt: null };
    return { buildId: commit === "unknown" ? null : commit, builtAt };
  } catch {
    return { buildId: null, builtAt: null };
  }
}
