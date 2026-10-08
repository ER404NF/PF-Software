"use strict";

// The two ways a damaged record of "which processes did Bodun start" is dealt with by a person:
//   - at launch, before any child starts: a record that is provably older than the Mac's last start is moved aside by itself;
//     one that is not is reported so the app can ASK;
//   - the Bodun menu action "Move Aside Damaged Process Records…", which refuses while Bodun's own server or site agent runs.
// Both only ever MOVE a damaged record to a timestamped safe copy next to it. Nothing is deleted. Valid records are never touched.

const nodeFs = require("fs");
const { classifyRecordFile, moveAside, recoverDamagedRecord, readBootTimeMs } = require("./damagedRecordRecovery");

// Words for the dialogs, as plain data so a test can read every sentence.
const DIALOG_TEXT = Object.freeze({
  confirmMessage: "Move aside the damaged process records?",
  confirmDetail: "This moves the damaged record to a safe copy next to it. Nothing is deleted. "
    + "If Bodun was force-quit a moment ago, restarting this Mac first is the safest choice: the record then fixes itself. "
    + "A leftover Bodun session may still need to be closed by hand.",
  refusalMessage: "Bodun's own server is running.",
  refusalDetail: "The damaged record cannot be moved while it runs. Quit Bodun and open it again. Bodun will then offer to move the damaged record aside.",
  nothingMessage: "No damaged process records were found.",
  failedMessage: "Bodun could not move the damaged record aside.",
  failedDetail: "Nothing was changed or deleted. Make sure Bodun's folder can be written to, then try again.",
  doneMessage: "The damaged record was moved aside.",
  doneDetail: "Restart Bodun so it can check its phones again.",
});

// → { recovered: [{ id, name }], needsPerson: [{ id, label, status }] }. Nothing is signalled and nothing is deleted.
function checkRecordsAtLaunch({ files, fsImpl = nodeFs, bootTime = () => readBootTimeMs(), now = () => Date.now(), randomSuffix, log = null }) {
  const recovered = [];
  const needsPerson = [];
  for (const file of files) {
    const outcome = recoverDamagedRecord({ fsImpl, filePath: file.filePath, key: file.key, bootTime, now, randomSuffix, log });
    if (outcome.recovered) { recovered.push({ id: file.id, name: outcome.name }); continue; }
    const state = classifyRecordFile({ fsImpl, filePath: file.filePath, key: file.key });
    if (state.status === "damaged" || state.status === "not_a_file") needsPerson.push({ id: file.id, label: file.label, status: state.status });
  }
  return { recovered, needsPerson };
}

// → [{ id, label, status }] for every record that is damaged or has something that is not a file in its place. Changes nothing.
function findDamagedRecords({ files, fsImpl = nodeFs }) {
  const damaged = [];
  for (const file of files) {
    const state = classifyRecordFile({ fsImpl, filePath: file.filePath, key: file.key });
    if (state.status === "damaged" || state.status === "not_a_file") damaged.push({ id: file.id, label: file.label, status: state.status });
  }
  return damaged;
}

// → { ok: false, reason: "running" } | { ok: true, moved: [{ id, name }], skipped: [{ id, status }] }
function moveAsideDamagedRecords({ files, fsImpl = nodeFs, isServerRunning, isAgentRunning, now = () => Date.now(), randomSuffix, log = null }) {
  if (isServerRunning?.() || isAgentRunning?.()) return { ok: false, reason: "running" };
  const moved = [];
  const skipped = [];
  for (const file of files) {
    const state = classifyRecordFile({ fsImpl, filePath: file.filePath, key: file.key });
    if (state.status === "unreadable") { skipped.push({ id: file.id, status: "unreadable" }); continue; }
    if (state.status !== "damaged" && state.status !== "not_a_file") continue;
    try {
      // The bytes that were judged damaged must be the bytes that are kept (a folder is moved as it is).
      const name = moveAside({
        fsImpl, filePath: file.filePath, now, randomSuffix,
        verify: state.status === "damaged" ? copyPath => { try { return fsImpl.readFileSync(copyPath, "utf8") === state.text; } catch { return false; } } : null,
      });
      if (name) { moved.push({ id: file.id, name }); log?.(`${file.label} was damaged and was moved aside to a safe copy`); }
    } catch {
      skipped.push({ id: file.id, status: "move_failed" });
    }
  }
  return { ok: true, moved, skipped };
}

function confirmationDialog(damaged) {
  const which = damaged.map(item => item.label).filter(Boolean);
  return {
    type: "warning", message: DIALOG_TEXT.confirmMessage,
    detail: `${which.length ? `Damaged: ${which.join("; ")}.\n\n` : ""}${DIALOG_TEXT.confirmDetail}`,
    buttons: ["Cancel", "Move aside"], defaultId: 0, cancelId: 0, noLink: true,
  };
}

function refusalDialog() {
  return { type: "info", message: DIALOG_TEXT.refusalMessage, detail: DIALOG_TEXT.refusalDetail, buttons: ["OK"], defaultId: 0, noLink: true };
}

function nothingFoundDialog() {
  return { type: "info", message: DIALOG_TEXT.nothingMessage, buttons: ["OK"], defaultId: 0, noLink: true };
}

function failedDialog() {
  return { type: "warning", message: DIALOG_TEXT.failedMessage, detail: DIALOG_TEXT.failedDetail, buttons: ["OK"], defaultId: 0, noLink: true };
}

function doneDialog() {
  return { type: "info", message: DIALOG_TEXT.doneMessage, detail: DIALOG_TEXT.doneDetail, buttons: ["Restart now", "Later"], defaultId: 0, cancelId: 1, noLink: true };
}

module.exports = {
  DIALOG_TEXT, checkRecordsAtLaunch, findDamagedRecords, moveAsideDamagedRecords, confirmationDialog, refusalDialog, nothingFoundDialog, failedDialog, doneDialog,
};
