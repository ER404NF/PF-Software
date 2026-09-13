// Parses the operator-facing slash commands from docs/COMMAND_QUEUE_SPEC.md
// into structured objects. Execution always uses these validated fields —
// never the raw text — per the spec's own opening line: "Natural language is
// allowed, but execution always uses validated structured fields."

import { PRIORITIES } from "./taskSpec.js";

const TIME_RANGE_RE = /^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function err(message) {
  return { error: message };
}

function isRealCalendarDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return candidate.getUTCFullYear() === year
    && candidate.getUTCMonth() === month - 1
    && candidate.getUTCDate() === day;
}

// "HH:MM" (on `now`'s date, or `onDate` if given) -> a Date. Doesn't
// reinterpret an already-past same-day time as tomorrow (COMMAND_QUEUE_SPEC.md
// §2) — that's the caller's job to detect and reject/flag, not this
// function's to hide. Takes `now` explicitly (never reads the real clock
// itself) so the "same-day" path stays exactly as deterministic under test
// as the explicit-date path already was.
function timeToDate(hhmm, onDate, now) {
  const [h, m] = hhmm.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m) || h > 23 || m > 59) return null;
  const base = onDate ? new Date(`${onDate}T00:00:00`) : new Date(now);
  base.setHours(h, m, 0, 0);
  return base;
}

// `/time <start>-<end> <task>` or `/time <YYYY-MM-DD> <start>-<end> <task>`
function parseTimeArgs(rest, now) {
  const parts = rest.trim().split(/\s+/);
  if (parts.length < 2) return err("usage: /time [YYYY-MM-DD] HH:MM-HH:MM <task>");

  let dateStr = null;
  let rangeToken = parts[0];
  let taskWords = parts.slice(1);
  if (DATE_RE.test(parts[0])) {
    dateStr = parts[0];
    if (!isRealCalendarDate(dateStr)) return err(`invalid calendar date: ${dateStr}`);
    rangeToken = parts[1];
    taskWords = parts.slice(2);
  }

  const match = TIME_RANGE_RE.exec(rangeToken);
  if (!match) return err(`invalid time range: ${rangeToken} (expected HH:MM-HH:MM)`);
  const goal = taskWords.join(" ").trim();
  if (!goal) return err("task description is required after the time range");

  const start = timeToDate(match[1], dateStr, now);
  const end = timeToDate(match[2], dateStr, now);
  if (!start || !end) return err(`invalid time range: ${rangeToken}`);
  if (start >= end) return err("start time must be before end time");
  // COMMAND_QUEUE_SPEC.md §2: never silently reinterpret an already-past
  // same-day window as tomorrow — reject it outright and let the operator
  // reschedule, rather than accepting it and having it expire moments later.
  if (end <= now) return err(`that window has already passed (ended ${end.toISOString()}) — reschedule it`);

  return {
    type: "time",
    goal,
    earliestStart: start.toISOString(),
    latestEnd: end.toISOString(),
  };
}

// Sugar over /time: `/cresearch <platform> [account-id] <minutes> <goal>` — formalizes
// what the code previously only referenced in comments (researchStore.js,
// index.js) as a bare convention. Compiles to the same TaskSpec shape /time
// produces, plus an accountSelector, from `now` (a bounded param, not
// Date.now() called internally, so this stays deterministic under test).
function parseCresearchArgs(rest, now) {
  const parts = rest.trim().split(/\s+/);
  const usage = "usage: /cresearch <platform> [account-id] <minutes> <goal> | /cresearch <platform> [--account <id>] --minutes <minutes> <goal>";
  if (parts.length < 3) return err(usage);
  const platform = parts[0].toLowerCase();
  let accountId = null;
  let minutesStr;
  let goalWords;
  if (parts[1] === "--account") {
    if (!parts[2] || parts[3] !== "--minutes" || !parts[4]) return err(usage);
    accountId = parts[2];
    minutesStr = parts[4];
    goalWords = parts.slice(5);
  } else if (parts[1] === "--minutes") {
    if (!parts[2]) return err(usage);
    minutesStr = parts[2];
    goalWords = parts.slice(3);
  } else {
    const hasExplicitAccount = !Number.isFinite(Number(parts[1]));
    if (!hasExplicitAccount && Number.isFinite(Number(parts[2]))) {
      return err(`ambiguous numeric account and duration; use --account <id> --minutes <minutes> (${usage})`);
    }
    accountId = hasExplicitAccount ? parts[1] : null;
    minutesStr = parts[hasExplicitAccount ? 2 : 1];
    goalWords = parts.slice(hasExplicitAccount ? 3 : 2);
  }
  const minutes = Number(minutesStr);
  if (!Number.isFinite(minutes) || minutes <= 0) return err(`invalid duration in minutes: ${minutesStr}`);
  const goal = goalWords.join(" ").trim();
  if (!goal) return err("goal is required");

  const start = new Date(now);
  const end = new Date(start.getTime() + minutes * 60 * 1000);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    return err(`invalid duration in minutes: ${minutesStr}`);
  }
  return {
    type: "cresearch",
    goal,
    accountSelector: { platform, ...(accountId !== null ? { accountId } : {}) },
    earliestStart: start.toISOString(),
    latestEnd: end.toISOString(),
  };
}

function parseModeArgs(rest) {
  const parts = rest.trim().split(/\s+/).filter(Boolean);
  const [mode, deviceId] = parts;
  if ((mode !== "human" && mode !== "ai") || parts.length > 2) return err("usage: /mode human|ai [deviceId]");
  return { type: "mode", mode, deviceId: deviceId ?? null };
}

function parseOptionalDeviceArgs(command, type, rest) {
  const parts = rest.trim().split(/\s+/).filter(Boolean);
  if (parts.length > 1) return err(`usage: /${command} [deviceId]`);
  return { type, deviceId: parts[0] ?? null };
}

// `/device health [deviceId]` — read-only, so (like /audit below) it isn't
// RBAC-gated the way a control command is: this codebase's own precedent
// (the WS device_list message) already shows every device's status to every
// authenticated operator, restricting RBAC to the point of actually acting
// on a device, not to seeing that it exists.
function parseDeviceArgs(rest) {
  const parts = rest.trim().split(/\s+/).filter(Boolean);
  const [sub, deviceId] = parts;
  if (sub !== "health") return err(`unknown /device subcommand: ${sub ?? "(none)"}`);
  if (parts.length > 2) return err("usage: /device health [deviceId]");
  return { type: "device_health", deviceId: deviceId ?? null };
}

// `/audit [device <id>|operator <username>] [limit]` — a console front end
// for the same auditLog.listEvents() the GET /api/audit route already uses.
// No date-range filter exists yet (COMMAND_QUEUE_SPEC.md's working-name list
// says "[range]"); today `[limit]` is a result-count cap, matching what
// listEvents actually supports.
function parseAuditArgs(rest) {
  const parts = rest.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { type: "audit", filterType: null, value: null, limit: null };

  const [filterType, value, limitStr] = parts;
  if (filterType !== "device" && filterType !== "operator") {
    return err("usage: /audit [device <id>|operator <username>] [limit]");
  }
  if (!value) return err(`usage: /audit ${filterType} <id> [limit]`);

  let limit = null;
  if (limitStr !== undefined) {
    limit = Number(limitStr);
    if (!Number.isFinite(limit) || limit <= 0) return err(`invalid limit: ${limitStr}`);
  }
  return { type: "audit", filterType, value, limit };
}

function parseModelArgs(rest) {
  const parts = rest.trim().split(/\s+/).filter(Boolean);
  if (parts[0] === "list" && parts.length === 1) return { type: "model_list" };
  if (parts[0] !== "set" || !parts[1]) {
    return err("usage: /model list | /model set <provider> [global|workspace <id>|device <id>|task <id>]");
  }
  const providerName = parts[1];
  if (parts.length === 2 || (parts.length === 3 && parts[2] === "global")) {
    return { type: "model_set", providerName, scope: "global", scopeId: null };
  }
  const [scope, scopeId] = parts.slice(2);
  if (!["workspace", "device", "task"].includes(scope) || !scopeId || parts.length !== 4) {
    return err("usage: /model set <provider> [global|workspace <id>|device <id>|task <id>]");
  }
  return { type: "model_set", providerName, scope, scopeId };
}

function parseQueueArgs(rest) {
  const parts = rest.trim().split(/\s+/).filter(Boolean);
  const [sub, ...args] = parts;
  switch (sub) {
    case "add":
      return { type: "queue_add", commandText: args.join(" ") };
    case "list":
      if (args.length) return err("usage: /queue list");
      return { type: "queue_list" };
    case "pause":
      if (args.length) return err("usage: /queue pause");
      return { type: "queue_pause" };
    case "resume":
      if (args.length) return err("usage: /queue resume");
      return { type: "queue_resume" };
    case "cancel":
      if (args.length !== 1) return err("usage: /queue cancel <task_id>");
      return { type: "queue_cancel", taskId: args[0] };
    case "move": {
      const [taskId, rel, targetId] = args;
      if (args.length !== 3 || !taskId || (rel !== "before" && rel !== "after") || !targetId) {
        return err("usage: /queue move <task_id> before|after <task_id>");
      }
      return { type: "queue_move", taskId, relation: rel, targetId };
    }
    case "priority": {
      const [taskId, priority] = args;
      if (args.length !== 2 || !taskId || !PRIORITIES.includes(priority)) {
        return err(`usage: /queue priority <task_id> ${PRIORITIES.join("|")}`);
      }
      return { type: "queue_priority", taskId, priority };
    }
    default:
      return err(`unknown /queue subcommand: ${sub ?? "(none)"}`);
  }
}

// `now` defaults to the real clock but is threaded through explicitly (not
// called internally deeper in the parse tree) so tests can pass a fixed
// timestamp and get fully deterministic /cresearch output.
function parseCommand(text, now = new Date()) {
  if (typeof text !== "string") return err("command must be a string");
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    // Not a structured command — a natural-language goal. The parser only
    // proposes the raw text as a goal; it does not infer criteria, a device,
    // or a time window. Turning this into a full TaskSpec is the model
    // layer's job (docs/CODING_ROADMAP.md MS8), kept out of this parser so
    // it stays provider-agnostic.
    return { type: "natural_language", goal: trimmed };
  }

  const spaceIdx = trimmed.indexOf(" ");
  const cmd = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1);

  switch (cmd) {
    case "/mode":
      return parseModeArgs(rest);
    case "/time":
      return parseTimeArgs(rest, now);
    case "/cresearch":
      return parseCresearchArgs(rest, now);
    case "/queue":
      return parseQueueArgs(rest);
    case "/device":
      return parseDeviceArgs(rest);
    case "/audit":
      return parseAuditArgs(rest);
    case "/model":
      return parseModelArgs(rest);
    case "/pause":
      return parseOptionalDeviceArgs("pause", "ai_pause", rest);
    case "/resume":
      return parseOptionalDeviceArgs("resume", "ai_resume", rest);
    case "/stop":
      return parseOptionalDeviceArgs("stop", "ai_stop", rest);
    case "/takeover":
      return parseOptionalDeviceArgs("takeover", "ai_takeover", rest);
    default:
      return err(`unknown command: ${cmd}`);
  }
}

export { parseCommand, parseTimeArgs, parseCresearchArgs, parseModelArgs };
