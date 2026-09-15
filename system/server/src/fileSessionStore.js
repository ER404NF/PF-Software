// A file-backed express-session Store. Without this, sessions live only in
// express-session's default MemoryStore — every operator gets signed out the
// instant the relay restarts, which is exactly the failure mode a VA mid-task
// shouldn't have to deal with.
//
// One JSON file per session under `dir`, matching this project's existing
// storage style (fileStore.js, researchStore.js) rather than pulling in a
// database for what's still small, low-throughput data.

import session from "express-session";
import fs from "fs";
import path from "path";
import crypto from "crypto";

// express-session generates ids via `uid-safe` (URL-safe base64: A-Za-z0-9-_)
// — this isn't user input, but validating it anyway costs nothing and means
// a session id is never trusted to shape a filesystem path unchecked.
const SID_PATTERN = /^[A-Za-z0-9_-]+$/;

export class FileSessionStore extends session.Store {
  constructor(dir, { now = () => Date.now(), tombstoneTtlMs = 24 * 60 * 60_000,
    sweepIntervalMs = 5 * 60_000, maxMemoryRevocations = 10_000 } = {}) {
    super();
    this.dir = dir;
    this.now = now;
    this.tombstoneTtlMs = tombstoneTtlMs;
    this.sweepIntervalMs = sweepIntervalMs;
    this.maxMemoryRevocations = maxMemoryRevocations;
    this.revoked = new Map();
    this.lastSweepAt = 0;
    fs.mkdirSync(dir, { recursive: true });
    this.sweep();
  }

  _file(sid) {
    if (!SID_PATTERN.test(sid)) return null;
    return path.join(this.dir, `${sid}.json`);
  }

  _isRevoked(sid) {
    const now = this.now();
    const memoryExpiry = this.revoked.get(sid);
    if (memoryExpiry > now) return true;
    if (memoryExpiry !== undefined) this.revoked.delete(sid);
    const tombstone = path.join(this.dir, `.${sid}.revoked`);
    try {
      const expiresAt = Number(fs.readFileSync(tombstone, "utf8"));
      if (Number.isFinite(expiresAt) && expiresAt > now) return true;
      if (!Number.isFinite(expiresAt)) {
        return fs.statSync(tombstone).mtimeMs + this.tombstoneTtlMs > now;
      }
      fs.rmSync(tombstone, { force: true });
      return false;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }

  _maybeSweep() {
    if (this.now() - this.lastSweepAt >= this.sweepIntervalMs) this.sweep();
  }

  sweep() {
    const now = this.now();
    for (const [sid, expiresAt] of this.revoked) if (expiresAt <= now) this.revoked.delete(sid);
    for (const name of fs.readdirSync(this.dir)) {
      const target = path.join(this.dir, name);
      const tombstone = name.match(/^\.([A-Za-z0-9_-]+)\.revoked$/);
      if (tombstone) {
        try {
          const expiresAt = Number(fs.readFileSync(target, "utf8"));
          const expired = Number.isFinite(expiresAt)
            ? expiresAt <= now
            : fs.statSync(target).mtimeMs + this.tombstoneTtlMs <= now;
          if (expired) fs.rmSync(target, { force: true });
        } catch (error) { if (error?.code !== "ENOENT") throw error; }
        continue;
      }
      if (!SID_PATTERN.test(name.replace(/\.json$/, "")) || !name.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
        if (parsed?.expires && Date.parse(parsed.expires) <= now) fs.rmSync(target, { force: true });
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        // Corrupt or unreadable sessions are operational failures, not
        // disposable missing sessions. get() will surface the same error.
      }
    }
    this.lastSweepAt = now;
  }

  get(sid, cb) {
    const file = this._file(sid);
    try {
      this._maybeSweep();
      if (!file || this._isRevoked(sid)) return cb(null, null);
    } catch (error) { return cb(error); }
    fs.readFile(file, "utf8", (err, data) => {
      if (err) return err.code === "ENOENT" ? cb(null, null) : cb(err);
      try { if (this._isRevoked(sid)) return cb(null, null); }
      catch (error) { return cb(error); }
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch (error) {
        return cb(error);
      }
      if (!parsed || typeof parsed !== "object" || !parsed.session || typeof parsed.session !== "object") {
        return cb(new Error("invalid session record"));
      }
      if (parsed.expires && Date.parse(parsed.expires) < this.now()) {
        return fs.unlink(file, error => error && error.code !== "ENOENT" ? cb(error) : cb(null, null));
      }
      cb(null, parsed.session);
    });
  }

  // Real bug this fixes: fs.writeFile is not atomic — it truncates the file
  // then writes the new content, so a concurrent get() landing in that
  // window can read a torn/empty file, fail JSON.parse, and come back as
  // "no session" (a spurious 401 for a perfectly valid, logged-in operator).
  // This was invisible until MS6.3's status pane became the first code path
  // to fire two concurrent authenticated requests for the same session
  // (Promise.all in client/app.js) — before that, requests from one browser
  // tab were effectively serialized, so the window was never actually hit.
  // Same root cause as the earlier-documented login/session-write race, but
  // this is mid-session, not login, so awaiting a response body doesn't
  // help — the fix has to be in the store itself: write to a uniquely-named
  // temp file, then fs.rename() into place. rename() is atomic (POSIX, and
  // NTFS for a same-volume rename) with respect to what a reader can see —
  // it only ever finds the complete old file or the complete new one, never
  // a partial write.
  set(sid, sessionData, cb) {
    const file = this._file(sid);
    if (!file) return cb(new Error("invalid session id"));
    try {
      this._maybeSweep();
      if (this._isRevoked(sid)) return cb(null);
    } catch (error) { return cb(error); }
    const expires = sessionData.cookie?.expires || null;
    const tmpFile = path.join(this.dir, `.${sid}.${crypto.randomUUID()}.tmp`);
    fs.writeFile(tmpFile, JSON.stringify({ session: sessionData, expires }), (writeErr) => {
      if (writeErr) return cb(writeErr);
      try {
        if (this._isRevoked(sid)) return fs.unlink(tmpFile, () => cb(null));
      } catch (error) {
        return fs.unlink(tmpFile, () => cb(error));
      }
      this._renameWithRetry(tmpFile, file, (renameErr) => {
        let revoked;
        try { revoked = this._isRevoked(sid); }
        catch (error) { return fs.unlink(tmpFile, () => cb(error)); }
        if (revoked) {
          fs.unlink(tmpFile, () => {});
          return fs.unlink(file, () => cb(null));
        }
        if (renameErr) fs.unlink(tmpFile, () => {}); // best-effort — don't leak the temp file on a failed rename
        cb(renameErr);
      });
    });
  }

  // Unlike POSIX, NTFS can refuse to rename onto an existing destination
  // while another handle has it open (EPERM/EBUSY) — and a concurrent get()
  // on this exact file is exactly the kind of handle that can be open for
  // the brief instant a rename lands. That handle closes on its own almost
  // immediately (get() is a single fs.readFile, not held open), so a short
  // bounded retry is the right fix here, not a design change — this is a
  // transient OS-level lock, not a real failure.
  _renameWithRetry(tmpFile, destFile, cb, attempt = 0) {
    fs.rename(tmpFile, destFile, (err) => {
      if (err && (err.code === "EPERM" || err.code === "EBUSY") && attempt < 10) {
        setTimeout(() => this._renameWithRetry(tmpFile, destFile, cb, attempt + 1), 5 * (attempt + 1));
        return;
      }
      cb(err ?? null);
    });
  }

  destroy(sid, cb) {
    const file = this._file(sid);
    if (!file) return cb();
    const expiresAt = this.now() + this.tombstoneTtlMs;
    this.revoked.set(sid, expiresAt);
    while (this.revoked.size > this.maxMemoryRevocations) this.revoked.delete(this.revoked.keys().next().value);
    try {
      // IDs are never reused. This tombstone also blocks stale writes/reads
      // across store instances or a relay restart.
      fs.writeFileSync(path.join(this.dir, `.${sid}.revoked`), `${expiresAt}\n`, { mode: 0o600 });
    } catch (error) { return cb(error); }
    fs.unlink(file, (err) => {
      if (err && err.code !== "ENOENT") return cb(err);
      cb();
    });
  }

  // Called instead of set() when resave:false and the session data itself
  // hasn't changed but its TTL should be refreshed — same effect either way
  // since set() already rewrites the expiry.
  touch(sid, sessionData, cb) {
    this.set(sid, sessionData, cb);
  }
}
