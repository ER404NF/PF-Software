import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { assertPlatformSkill } from "./platformSkill.js";
import { withPlatformActions } from "./platformSkills/toggleActions.js";
import { createInstagramSkill } from "./platformSkills/instagramSkill.js";
import { createRedditSkill } from "./platformSkills/redditSkill.js";
import { createXSkill } from "./platformSkills/xSkill.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = process.env.PLATFORM_SKILLS_CONFIG_PATH
  ? path.resolve(process.env.PLATFORM_SKILLS_CONFIG_PATH)
  : path.join(__dirname, "../../platform-skills.config.json");
const BUILDERS = { instagram: createInstagramSkill, reddit: createRedditSkill, x: createXSkill };

export function buildPlatformSkills(config) {
  if (!Array.isArray(config?.skills)) throw new Error("platform skill config requires a skills array");
  const skills = new Map();
  for (const entry of config.skills) {
    if (entry?.enabled === false) continue;
    const builder = BUILDERS[entry?.platform];
    if (!builder) throw new Error(`unsupported platform skill: ${entry?.platform}`);
    if (skills.has(entry.platform)) throw new Error(`duplicate platform skill: ${entry.platform}`);
    skills.set(entry.platform, assertPlatformSkill(withPlatformActions(builder({ appVersion: entry.appVersion }))));
  }
  return skills;
}

const config = fs.existsSync(configPath)
  ? JSON.parse(fs.readFileSync(configPath, "utf8")) : { skills: [] };
export const platformSkills = buildPlatformSkills(config);

export function getPlatformSkill(platform) {
  return platformSkills.get(platform) ?? null;
}
