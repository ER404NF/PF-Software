import {
  listRuns, getRun, createRun, appendCandidate, locateCandidate,
  recordPlatformAction, finalizeRun, setCandidateStatus,
} from "../researchStore.js";
import { assertResearchRunRepository } from "./researchRunRepository.js";

// Adapts the existing file-backed research store (module-level functions
// reading/writing under RESEARCH_ROOT) to the research run repository port.
// Accepts injected function overrides for tests, matching how
// researchTaskRunner.js already dependency-injects these individually.
export function createFileResearchRunRepository(overrides = {}) {
  return assertResearchRunRepository({
    listRuns: overrides.listRuns ?? listRuns,
    getRun: overrides.getRun ?? getRun,
    createRun: overrides.createRun ?? createRun,
    appendCandidate: overrides.appendCandidate ?? appendCandidate,
    locateCandidate: overrides.locateCandidate ?? locateCandidate,
    recordPlatformAction: overrides.recordPlatformAction ?? recordPlatformAction,
    finalizeRun: overrides.finalizeRun ?? finalizeRun,
    setCandidateStatus: overrides.setCandidateStatus ?? setCandidateStatus,
  });
}
