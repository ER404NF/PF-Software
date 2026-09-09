import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "phonefarm-evidence-"));
process.env.RESEARCH_EVIDENCE_DIR = root;
const { saveResearchEvidence, resolveResearchEvidence } = await import("../../src/researchEvidenceStore.js");
after(() => fs.rmSync(root, { recursive: true, force: true }));

const png = { kind: "image", mime: "image/png", data: Buffer.from("real-image-bytes").toString("base64") };

test("research evidence writes bytes under the authorized workspace/account path", () => {
  const saved = saveResearchEvidence("client-a", "account-a", png);
  assert.match(saved.id, /^evidence-.*\.png$/);
  assert.equal(saved.ref, `/api/research/account-a/evidence/${saved.id}`);
  const resolved = resolveResearchEvidence("client-a", "account-a", saved.id);
  assert.equal(fs.readFileSync(resolved.file).toString(), "real-image-bytes");
  assert.equal(resolveResearchEvidence("client-b", "account-a", saved.id), null);
  assert.equal(resolveResearchEvidence("client-a", "account-a", "../escape.png"), null);
});

test("research evidence rejects unsupported and malformed image data", () => {
  assert.throws(() => saveResearchEvidence("client-a", "account-a",
    { kind: "image", mime: "image/svg+xml", data: png.data }), /supported image frame/);
  assert.throws(() => saveResearchEvidence("client-a", "account-a",
    { kind: "image", mime: "image/png", data: "%%%" }), /invalid base64/);
  assert.equal(saveResearchEvidence("../bad", "account-a", png), null);
});
