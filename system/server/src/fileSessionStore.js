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
  constructor(dir) {
    super();
    this.dir = dir;
    this.revoked = new Set();
    fs.mkdirSync(dir, { recursive: true });
  }

  _file(sid) {
    if (!SID_PATTERN.test(sid)) return null;
    return path.join(this.dir, `${sid}.json`);
  }

  _isRevoked(sid) {
    return this.revoked.has(sid) || fs.existsSync(path.join(this.dir, `.${sid}.revoked`));
  }

  get(sid, cb) {
    const file = this._file(sid);
    if (!file || this._isRevoked(sid)) return cb(null, null);
    fs.readFile(file, "utf8", (err, data) => {
      if (err || this._isRevoked(sid)) return cb(null, null); // ENOENT (no session yet) is not an error here
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        return cb(null, null);
      }
      if (parsed.expires && new Date(parsed.expires) < new Date()) {
        return this.destroy(sid, () => cb(null, null));
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
    if (this._isRevoked(sid)) return cb(null);
    const expires = sessionData.cookie?.expires || null;
    const tmpFile = path.join(this.dir, `.${sid}.${crypto.randomUUID()}.tmp`);
    fs.writeFile(tmpFile, JSON.stringify({ session: sessionData, expires }), (writeErr) => {
      if (writeErr) return cb(writeErr);
      if (this._isRevoked(sid)) return fs.unlink(tmpFile, () => cb(null));
      this._renameWithRetry(tmpFile, file, (renameErr) => {
        if (this._isRevoked(sid)) {
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
    this.revoked.add(sid);
    try {
      // IDs are never reused. This tombstone also blocks stale writes/reads
      // across store instances or a relay restart.
      fs.writeFileSync(path.join(this.dir, `.${sid}.revoked`), "revoked\n");
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
