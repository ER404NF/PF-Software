import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { operators } from "./authStore.js";
import { validResearchId } from "./researchId.js";
import { parseActionPolicies } from "./actionPolicy.js";

export { validResearchId };

export const RESEARCH_PLATFORMS = Object.freeze(["instagram", "reddit", "x"]);
const RESEARCH_PLATFORM_SET = new Set(RESEARCH_PLATFORMS);

export function parseResearchAccountDefinitions(config) {
  if (!Array.isArray(config?.accounts)) throw new Error("research config requires an accounts array");
  const accounts = new Map();
  for (const account of config.accounts) {
    if (!validResearchId(account?.id) || !validResearchId(account?.workspaceId)) {
      throw new Error("research account id and workspaceId must be lowercase safe IDs (1-100 characters, no Windows device names)");
    }
    if (!RESEARCH_PLATFORM_SET.has(account?.platform)) {
      throw new Error(`research account "${account.id}" requires platform: ${RESEARCH_PLATFORMS.join("|" )}`);
    }
    if (accounts.has(account.id)) throw new Error(`duplicate research account: ${account.id}`);
    accounts.set(account.id, Object.freeze({ id: account.id, workspaceId: account.workspaceId, platform: account.platform }));
  }
  return accounts;
}

// Account IDs remain globally unique so existing account URLs stay unambiguous.
// Missing ownership never falls back to a shared/global workspace.
export function parseResearchAccounts(config) {
  return new Map([...parseResearchAccountDefinitions(config)].map(([id, account]) => [id, account.workspaceId]));
}

const configPath = process.env.RESEARCH_CONFIG_PATH || fileURLToPath(new URL("../../research.config.json", import.meta.url));
const researchConfig = fs.existsSync(configPath)
  ? JSON.parse(fs.readFileSync(path.resolve(configPath), "utf8")) : { accounts: [] };
export const researchAccounts = parseResearchAccounts(researchConfig);
export const researchAccountDefinitions = parseResearchAccountDefinitions(researchConfig);
export const researchActionPolicies = parseActionPolicies(researchConfig);

export function researchWorkspaceFor(operator, accountId) {
  if (!validResearchId(accountId)) return null;
  const workspaceId = researchAccounts.get(accountId);
  // Resolve grants from the current operator registry, never a persisted
  // session snapshot. Removed operators and legacy sessions fail closed.
  const current = operators.get(operator?.username);
  const grants = current?.allowedResearchWorkspaces;
  return workspaceId && Array.isArray(grants) && grants.includes(workspaceId) ? workspaceId : null;
}
