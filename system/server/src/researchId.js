// The single canonical validator for a research workspace/account id string,
// shared by every place one gets parsed or checked. This exists because it
// used to be defined independently in three places (researchAccess.js's own
// validator, authStore.js's operator-config loader, and create-operator.js's
// CLI argument parser) — the first was lowercase-only ("canonical lowercase
// IDs avoid case aliases on Windows filesystems"), the other two silently
// allowed uppercase. A grant like `allowedResearchWorkspaces: ["Client-A"]`
// (meant to reference the real, lowercase `client-a` workspace) would load
// without error, look present in an operator's config, and then simply never
// match anything at request time — researchAccess.js's `researchWorkspaceFor`
// does `grants.includes(workspaceId)` against an always-lowercase
// `workspaceId`, so the mismatch fails silently and permanently, with no
// error or warning anywhere in the stack. Importing the same function
// everywhere makes that class of drift structurally impossible, not just
// fixed for today.
function validResearchId(id) {
  return typeof id === "string" && /^[a-z0-9][a-z0-9_-]{0,99}$/.test(id)
    && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(id);
}

export { validResearchId };
