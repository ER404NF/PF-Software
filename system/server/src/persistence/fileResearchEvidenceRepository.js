import { saveResearchEvidence, resolveResearchEvidence } from "../researchEvidenceStore.js";
import { assertResearchEvidenceRepository } from "./researchEvidenceRepository.js";

// Adapts the existing file-backed research evidence store to the research
// evidence repository port. No behavior change: delegates to the real
// researchEvidenceStore.js functions unless overridden for tests.
export function createFileResearchEvidenceRepository(overrides = {}) {
  return assertResearchEvidenceRepository({
    save: overrides.save ?? saveResearchEvidence,
    resolve: overrides.resolve ?? resolveResearchEvidence,
  });
}
