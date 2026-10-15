import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { down } from "../../migrations/1758851100000_durable-account-notification-outbox.js";

test("durable notification migration refuses a destructive rollback", async () => {
  let queried = false;
  await assert.rejects(() => down({ db: { query: async () => { queried = true; } } }), /intentionally irreversible/);
  assert.equal(queried, false, "rollback fails before deleting or rewriting audit records");
  const source = fs.readFileSync(fileURLToPath(new URL("../../migrations/1758851100000_durable-account-notification-outbox.js", import.meta.url)), "utf8");
  assert.doesNotMatch(source, /DELETE FROM automation\.account_notifications/);
  assert.match(source, /attempt_cycle_count/);
  assert.match(source, /manual_retry_count/);
});
