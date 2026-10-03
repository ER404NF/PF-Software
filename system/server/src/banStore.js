import fs from "fs";
import path from "path";
import crypto from "crypto";

// Best-effort IP blocklist for banned accounts (see index.js's "banned"
// handling in the account-review route, and authStore.js's
// recordOperatorLoginIp and the atomic account-status mutation). Checked at
// /api/signup so a
// banned person cannot re-apply under a new username from an IP address they
// were recently seen using. Account status is the authoritative login gate;
// shared networks make an IP block inappropriate for existing-account login.
//
// This is a defense-in-depth layer, not an unbreakable perimeter: it only
// knows the specific IP addresses this account was last seen logging in
// from (at most MAX_RECENT_LOGIN_IPS of them). Anyone with a new IP address
// — a different network, a VPN/proxy, mobile data, a new device on a new
// connection — is not stopped by this alone. There is no client-side device
// fingerprinting or jailbreak-detection in this codebase to layer on top of
// it yet. Documented as a known limitation, not silently overclaimed.
export function createBanStore({ storePath } = {}) {
  if (typeof storePath !== "string" || !storePath) throw new Error("ban store path is required");

  function read() {
    if (!fs.existsSync(storePath)) return [];
    const value = JSON.parse(fs.readFileSync(storePath, "utf8"));
    return Array.isArray(value?.entries) ? value.entries : [];
  }

  function write(entries) {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const temporary = `${storePath}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      fs.renameSync(temporary, storePath);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  function banIps(ips, { username, reason = null } = {}) {
    if (!Array.isArray(ips) || !ips.length) return;
    const entries = read();
    const existingIps = new Set(entries.map(entry => entry.ip));
    const bannedAt = new Date().toISOString();
    for (const ip of ips) {
      if (typeof ip !== "string" || !ip || existingIps.has(ip)) continue;
      entries.push({ ip, username: username ?? null, reason: reason ?? null, bannedAt });
      existingIps.add(ip);
    }
    write(entries);
  }

  function unbanIps(ips) {
    if (!Array.isArray(ips) || !ips.length) return;
    const toRemove = new Set(ips);
    write(read().filter(entry => !toRemove.has(entry.ip)));
  }

  function isBanned(ip) {
    if (typeof ip !== "string" || !ip) return false;
    return read().some(entry => entry.ip === ip);
  }

  function list() {
    return read().map(entry => ({ ...entry }));
  }

  return { banIps, unbanIps, isBanned, list };
}
