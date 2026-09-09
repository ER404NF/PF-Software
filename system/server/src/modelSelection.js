import fs from "fs";
import path from "path";
import crypto from "crypto";

const SCOPES = Object.freeze(["global", "workspace", "device", "task"]);
const SAFE_SCOPE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;

function emptySelections() {
  return { global: null, workspace: Object.create(null), device: Object.create(null), task: Object.create(null) };
}

export function createModelSelection({ providers, defaultProviderName = null, storePath } = {}) {
  if (!(providers instanceof Map)) throw new Error("model selection requires a provider map");
  if (typeof storePath !== "string" || !storePath) throw new Error("model selection requires a storePath");
  let selections = emptySelections();
  if (fs.existsSync(storePath)) {
    const saved = JSON.parse(fs.readFileSync(storePath, "utf8"));
    if (typeof saved?.global === "string" && providers.has(saved.global)) selections.global = saved.global;
    for (const scope of ["workspace", "device", "task"]) {
      for (const [id, provider] of Object.entries(saved?.[scope] || {})) {
        if (SAFE_SCOPE_ID.test(id) && providers.has(provider)) selections[scope][id] = provider;
      }
    }
  }

  function persist(nextSelections) {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const temporary = `${storePath}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(nextSelections, null, 2), { flag: "wx" });
      fs.renameSync(temporary, storePath);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  function set(providerName, { scope = "global", scopeId = null } = {}) {
    if (!providers.has(providerName)) throw new Error(`unknown model provider: ${providerName}`);
    if (!SCOPES.includes(scope)) throw new Error(`invalid model scope: ${scope}`);
    const nextSelections = {
      global: selections.global,
      workspace: { ...selections.workspace },
      device: { ...selections.device },
      task: { ...selections.task },
    };
    if (scope === "global") {
      if (scopeId != null) throw new Error("global model scope does not take an id");
      nextSelections.global = providerName;
    } else {
      if (typeof scopeId !== "string" || !SAFE_SCOPE_ID.test(scopeId)) throw new Error(`${scope} model scope requires a safe id`);
      nextSelections[scope][scopeId] = providerName;
    }
    // Commit the live selection only after the durable write succeeds. If
    // storage is unavailable, the command must fail without changing which
    // provider the running process will use.
    persist(nextSelections);
    selections = nextSelections;
    return { providerName, scope, scopeId };
  }

  function resolve({ taskId = null, workspaceId = null, deviceId = null } = {}) {
    return (taskId && selections.task[taskId])
      || (deviceId && selections.device[deviceId])
      || (workspaceId && selections.workspace[workspaceId])
      || selections.global
      || (defaultProviderName && providers.has(defaultProviderName) ? defaultProviderName : null);
  }

  function describe() {
    return {
      configuredProviders: [...providers.keys()],
      configuredDefault: defaultProviderName,
      selections: JSON.parse(JSON.stringify(selections)),
    };
  }

  return { set, resolve, describe };
}

export { SCOPES };
