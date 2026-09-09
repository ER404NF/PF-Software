// Append-only audit trail: who did what, when. One JSON object per line
// (not a JSON array) — a crash mid-write can never corrupt earlier entries,
// since each line is independently parseable regardless of the last one.
//
// A factory rather than fixed-path exported functions (unlike fileStore.js/
// researchStore.js) because tests need an isolated log file per run, not the
// real one under storage/audit/.

import fs from "fs";
import path from "path";
import crypto from "crypto";

export function createAuditLog(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  function logEvent({ operator, type, deviceId = null, detail = {} }) {
    const entry = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      operator: operator ?? null,
      type,
      deviceId,
      detail,
    };
    fs.appendFileSync(filePath, JSON.stringify(entry) + "\n");
    return entry;
  }

  function listEvents({ operator, deviceId, limit = 200 } = {}) {
    if (!fs.existsSync(filePath)) return [];
    let events = fs
      .readFileSync(filePath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null; // a torn/partial last line from a crash mid-write — skip it, don't fail the whole read
        }
      })
      .filter(Boolean);

    if (operator) events = events.filter((e) => e.operator === operator);
    if (deviceId) events = events.filter((e) => e.deviceId === deviceId);

    events.reverse(); // newest first — the order an audit review actually wants
    return events.slice(0, limit);
  }

  return { logEvent, listEvents, filePath };
}
