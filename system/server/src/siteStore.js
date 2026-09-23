// Registry of the physical sites (a Mac mini and its phones, in some office or
// city) that connect to this hub. A site never gets a login: it holds one
// long-random enrollment token, and only its SHA-256 is stored, so a leaked
// sites.json cannot be used to impersonate a site. The token is shown once, when
// the site is created or rotated.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const SITE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/;
const TOKEN_PREFIX = "pfs_";

export class SiteError extends Error {
  constructor(message, code = "invalid_site") {
    super(message);
    this.name = "SiteError";
    this.code = code;
  }
}

function validTimeZone(value) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function slugify(name) {
  return String(name).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30).replace(/-+$/g, "");
}

const hashToken = token => crypto.createHash("sha256").update(token).digest("hex");
const newToken = () => `${TOKEN_PREFIX}${crypto.randomBytes(32).toString("base64url")}`;

export class SiteStore {
  constructor(filePath, { defaultTimeZone = "America/Los_Angeles" } = {}) {
    this.filePath = filePath;
    this.defaultTimeZone = defaultTimeZone;
    this.sites = new Map();
    this._load();
  }

  _load() {
    if (!this.filePath || !fs.existsSync(this.filePath)) return;
    const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    for (const site of Array.isArray(raw?.sites) ? raw.sites : []) {
      if (SITE_ID_PATTERN.test(site?.id) && typeof site.tokenHash === "string") this.sites.set(site.id, site);
    }
  }

  _save() {
    if (!this.filePath) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ sites: [...this.sites.values()] }, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, this.filePath);
  }

  static publicView(site) {
    const { tokenHash, ...rest } = site;
    return rest;
  }

  list() {
    return [...this.sites.values()].map(SiteStore.publicView).sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id) {
    const site = this.sites.get(id);
    return site ? SiteStore.publicView(site) : null;
  }

  // Returns { site, token }; the token is never retrievable again.
  create({ name, id = null, timeZone = null }) {
    const displayName = typeof name === "string" ? name.trim() : "";
    if (displayName.length < 2 || displayName.length > 60) throw new SiteError("A site name must be 2 to 60 characters.");
    const siteId = id ?? slugify(displayName);
    if (!SITE_ID_PATTERN.test(siteId)) throw new SiteError("A site id may use lowercase letters, digits and hyphens (2 to 30 characters).");
    if (this.sites.has(siteId)) throw new SiteError(`A site with the id "${siteId}" already exists.`, "duplicate_site");
    const zone = timeZone ?? this.defaultTimeZone;
    if (!validTimeZone(zone)) throw new SiteError("That time zone is not recognised.");
    const token = newToken();
    const now = new Date().toISOString();
    const site = { id: siteId, name: displayName, timeZone: zone, tokenHash: hashToken(token), createdAt: now, rotatedAt: now, lastSeenAt: null };
    this.sites.set(siteId, site);
    this._save();
    return { site: SiteStore.publicView(site), token };
  }

  rotate(id) {
    const site = this.sites.get(id);
    if (!site) throw new SiteError("Unknown site.", "unknown_site");
    const token = newToken();
    site.tokenHash = hashToken(token);
    site.rotatedAt = new Date().toISOString();
    this._save();
    return { site: SiteStore.publicView(site), token };
  }

  update(id, { name, timeZone }) {
    const site = this.sites.get(id);
    if (!site) throw new SiteError("Unknown site.", "unknown_site");
    if (name !== undefined) {
      const displayName = String(name).trim();
      if (displayName.length < 2 || displayName.length > 60) throw new SiteError("A site name must be 2 to 60 characters.");
      site.name = displayName;
    }
    if (timeZone !== undefined) {
      if (!validTimeZone(timeZone)) throw new SiteError("That time zone is not recognised.");
      site.timeZone = timeZone;
    }
    this._save();
    return SiteStore.publicView(site);
  }

  remove(id) {
    const previous = this.sites.get(id);
    if (!previous) return false;
    this.sites.delete(id);
    try {
      this._save();
      return true;
    } catch (error) {
      this.sites.set(id, previous);
      throw error;
    }
  }

  // Constant-time comparison of the presented token against the stored hash.
  verifyToken(id, token) {
    const site = this.sites.get(id);
    if (!site || typeof token !== "string" || !token.startsWith(TOKEN_PREFIX) || token.length > 200) return null;
    const presented = Buffer.from(hashToken(token), "hex");
    const stored = Buffer.from(site.tokenHash, "hex");
    return presented.length === stored.length && crypto.timingSafeEqual(presented, stored) ? SiteStore.publicView(site) : null;
  }

  markSeen(id, at = new Date().toISOString()) {
    const site = this.sites.get(id);
    if (!site) return;
    site.lastSeenAt = at;
    this._save();
  }
}
