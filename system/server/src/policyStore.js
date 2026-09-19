// Runtime per-account action policy (roadmap MS10.1; `/policy get|set`). The shipped
// research.config.json defines the starting policy; changes made while running are
// kept here (and audited by the caller), so an admin can tighten or loosen a single
// action without redeploying. Everything defaults to DISABLED and the validator
// treats an unknown value as DISABLED, so a corrupt file can only ever restrict.

import fs from "node:fs";
import path from "node:path";
import { ACTIONS, POLICY_VALUES } from "./actionPolicy.js";

const ACTION_SET = new Set(ACTIONS);
const VALUE_SET = new Set(Object.values(POLICY_VALUES));

export class PolicyStore {
  constructor({ filePath = null, now = () => new Date().toISOString() } = {}) {
    this.filePath = filePath;
    this.now = now;
    this.overrides = {}; // accountId -> { action -> { value, by, at } }
    if (filePath && fs.existsSync(filePath)) {
      try { this.overrides = JSON.parse(fs.readFileSync(filePath, "utf8")).overrides ?? {}; } catch { this.overrides = {}; }
    }
  }

  _save() {
    if (!this.filePath) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ overrides: this.overrides }, null, 2));
    fs.renameSync(temporary, this.filePath);
  }

  set(accountId, action, value, by = null) {
    if (!ACTION_SET.has(action)) throw new Error(`unknown action "${action}"`);
    if (!VALUE_SET.has(value)) throw new Error(`policy must be one of ${[...VALUE_SET].join(", ")}`);
    (this.overrides[accountId] ??= {})[action] = { value, by, at: this.now() };
    this._save();
    return this.overrides[accountId][action];
  }

  clear(accountId, action) {
    if (this.overrides[accountId]?.[action]) {
      delete this.overrides[accountId][action];
      this._save();
    }
  }

  // The policy the validator sees: configured values with runtime overrides on top.
  effective(basePolicies) {
    const merged = new Map();
    for (const [accountId, base] of basePolicies ?? []) merged.set(accountId, { ...base });
    for (const [accountId, actions] of Object.entries(this.overrides)) {
      const target = merged.get(accountId) ?? Object.create(null);
      for (const [action, entry] of Object.entries(actions)) if (VALUE_SET.has(entry?.value) && ACTION_SET.has(action)) target[action] = entry.value;
      merged.set(accountId, target);
    }
    return merged;
  }

  describe(accountId, basePolicies) {
    const base = basePolicies?.get(accountId) ?? {};
    return ACTIONS.map(action => ({
      action,
      policy: this.overrides[accountId]?.[action]?.value ?? base[action] ?? POLICY_VALUES.DISABLED,
      source: this.overrides[accountId]?.[action] ? "runtime" : base[action] ? "config" : "default",
      changedBy: this.overrides[accountId]?.[action]?.by ?? null,
    }));
  }
}
