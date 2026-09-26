import fs from "fs";
import path from "path";
import crypto from "crypto";
import { assertTaskQueueSnapshotRepository, normalizeQueueSnapshot } from "./taskQueueSnapshotRepository.js";

// Moved unchanged from taskQueue.js as part of the task-queue snapshot
// persistence slice: identical atomic-write-with-retry behavior, identical
// legacy-format/interrupted-task recovery on load.
const replaceWaitArray = new Int32Array(new SharedArrayBuffer(4));

export function createFileTaskQueueSnapshotRepository(storePath) {
  if (typeof storePath !== "string" || !storePath) {
    throw new TypeError("file task queue snapshot repository requires a storePath");
  }

  function save(tasks, paused, humanHolds = new Set()) {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const temporary = `${storePath}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ version: 2, paused, humanHolds: [...humanHolds], tasks }, null, 2), { flag: "wx" });
      for (let attempt = 0; ; attempt++) {
        try {
          fs.renameSync(temporary, storePath);
          break;
        } catch (error) {
          if (!["EPERM", "EBUSY"].includes(error?.code) || attempt >= 10) throw error;
          Atomics.wait(replaceWaitArray, 0, 0, 5 * (attempt + 1));
        }
      }
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  function load() {
    if (!fs.existsSync(storePath)) return { tasks: [], paused: false, humanHolds: new Set() };
    const stored = JSON.parse(fs.readFileSync(storePath, "utf8"));
    const { tasks, paused, humanHolds, changed } = normalizeQueueSnapshot(stored);
    if (changed) save(tasks, paused, humanHolds);
    return { tasks, paused, humanHolds };
  }

  return assertTaskQueueSnapshotRepository({ load, save });
}
