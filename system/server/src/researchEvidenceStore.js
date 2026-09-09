import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { validResearchId } from "./researchId.js";
import { validateImageFrame } from "./observationPackage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const EVIDENCE_ROOT = process.env.RESEARCH_EVIDENCE_DIR
  ? path.resolve(process.env.RESEARCH_EVIDENCE_DIR)
  : path.join(__dirname, "../../storage/research-evidence");
const MIME_EXTENSIONS = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
const EVIDENCE_ID = /^evidence-[0-9a-f-]+\.(?:png|jpg|webp)$/;

function accountDirectory(workspaceId, accountId) {
  if (!validResearchId(workspaceId) || !validResearchId(accountId)) return null;
  return path.join(EVIDENCE_ROOT, workspaceId, accountId);
}

export function saveResearchEvidence(workspaceId, accountId, frame) {
  const directory = accountDirectory(workspaceId, accountId);
  if (!directory) return null;
  const valid = validateImageFrame(frame);
  const id = `evidence-${crypto.randomUUID()}.${MIME_EXTENSIONS[valid.mime]}`;
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, id);
  const temporary = `${file}.tmp`;
  try {
    fs.writeFileSync(temporary, Buffer.from(valid.data, "base64"), { flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return { id, ref: `/api/research/${accountId}/evidence/${id}`, mime: valid.mime, bytes: fs.statSync(file).size };
}

export function resolveResearchEvidence(workspaceId, accountId, evidenceId) {
  const directory = accountDirectory(workspaceId, accountId);
  if (!directory || typeof evidenceId !== "string" || !EVIDENCE_ID.test(evidenceId)) return null;
  const file = path.join(directory, evidenceId);
  if (!fs.existsSync(file)) return null;
  const ext = path.extname(evidenceId).toLowerCase();
  const mime = ext === ".png" ? "image/png" : ext === ".jpg" ? "image/jpeg" : "image/webp";
  return { file, mime };
}
