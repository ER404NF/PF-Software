// Starts automatic WebDriverAgent provisioning (find USB iPhones, build/run WDA on
// each, forward its ports). Shared by the full server and by the site agent, so a
// remote site's Mac mini provisions phones exactly like a single-machine install.
//
// Opt-in (AUTO_PROVISION_WDA=true). Manually pinned devices.config.json WDA entries
// are left untouched: only UDIDs with no explicit config entry are provisioned.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverIosDevicesResult } from "./deviceDiscovery.js";
import { runHostPreflight } from "./hostPreflight.js";
import { resolvePortRange, resolveMjpegPortRange } from "./portAllocator.js";
import { WdaProcessManager } from "./wdaProcessManager.js";
import { IProxyManager } from "./iproxyManager.js";
import { DeviceProvisioner } from "./deviceProvisioner.js";
import { createProcessInspector } from "./processInspector.js";
import { createProcessOwnershipStore } from "./processOwnershipStore.js";
import { createPortReclaimer } from "./portReclaimer.js";
import { removeStatusFile, writeStatusFile } from "./automaticSetupStatusFile.js";

const here = path.dirname(fileURLToPath(import.meta.url));

// Where the list of "processes this Bodun started" lives: an explicit path, else
// next to the phone-provisioning store (app storage on the desktop host and on a
// site agent), else the repository's own storage folder in a development run.
export function resolveOwnershipStorePath(env = process.env) {
  if (env.PROCESS_OWNERSHIP_PATH) return env.PROCESS_OWNERSHIP_PATH;
  if (env.DEVICE_PROVISIONING_STORE_PATH) return path.join(path.dirname(env.DEVICE_PROVISIONING_STORE_PATH), "process-ownership.json");
  return path.join(here, "../../storage/process-ownership.json");
}

// Everything is read from the `env` that is passed in - never from the global process.env - so a caller that supplies
// its own environment (the desktop host, a test, the site agent) gets exactly the tools and signing settings it named.
// `deps` exists so a test can observe what would be used without running Xcode.
const REAL = {
  runPreflight: runHostPreflight,
  discover: discoverIosDevicesResult,
  createWdaManager: options => new WdaProcessManager(options),
  createIproxyManager: options => new IProxyManager(options),
  createProvisioner: options => new DeviceProvisioner(options),
  createInspector: () => createProcessInspector(),
};

// What gets written to the audit log (or, on a site agent that has none, to the operational log)
// when a leftover is stopped or a foreign program is found on a port. Only program name, process
// number and port — never a command line.
function describeOwnershipEvent(event) {
  return `${event.type}: device ${event.deviceId ?? "unknown"}, port ${event.port}, program ${event.program ?? "unknown"}, process ${event.pid}, ${event.outcome}`;
}

// Returns the running provisioner, undefined when provisioning is not enabled, or
// null when it was enabled but could not start (the reason is logged loudly).
export function startAutoProvisioning({ env = process.env, devices, manualUdids, onDeviceListChanged = () => {}, onAudit = null, deps = {} }) {
  if (env.AUTO_PROVISION_WDA !== "true") return undefined;
  const use = { ...REAL, ...deps };
  const tools = {
    iproxyBin: env.IPROXY_BIN || "iproxy",
    xcodeSelectBin: env.XCODE_SELECT_BIN || "xcode-select",
    xcodebuildBin: env.XCODEBUILD_BIN || "xcodebuild",
    ideviceIdBin: env.IDEVICE_ID_BIN || "idevice_id",
    ideviceInfoBin: env.IDEVICEINFO_BIN || "ideviceinfo",
  };
  const preflight = use.runPreflight({ wdaRepoPath: env.WDA_REPO_PATH, ...tools });
  if (!preflight.ok) {
    console.error("Automatic WDA provisioning is disabled — host preflight failed:");
    for (const check of preflight.checks) if (!check.ok) console.error(`  [${check.id}] ${check.message}`);
    return null;
  }
  try {
    // Ownership of every process Bodun starts is remembered on disk, so a leftover from an earlier
    // run can be recognised (and only a provable leftover is ever stopped).
    const inspector = use.createInspector();
    const owner = { pid: process.pid, startTime: null };
    Promise.resolve(inspector.describe(process.pid)).then(description => { if (description?.startTime) owner.startTime = description.startTime; }).catch(() => {});
    const ownershipStore = createProcessOwnershipStore({
      filePath: resolveOwnershipStorePath(env), inspector, owner, log: line => console.warn(`[ownership] ${line}`),
    });
    const portReclaimer = createPortReclaimer({
      inspector,
      onAudit: event => { if (onAudit) onAudit(event); else console.log(`[ownership] ${describeOwnershipEvent(event)}`); },
    });
    const ownershipPath = resolveOwnershipStorePath(env);
    // Every change of the status of automatic phone setup: one plain log line (the site agent has no page, and the desktop
    // log is what Copy Diagnostics shows), and a small status file for Copy Diagnostics.
    const onSetupStatusChanged = status => {
      console.log(`[setup] ${status.message}`);
      writeStatusFile({ ownershipPath, status, pid: process.pid, now: deps.now });
    };
    const provisioner = use.createProvisioner({
      onSetupStatusChanged,
      devices,
      discoverIosDevices: () => use.discover({ ideviceIdBin: tools.ideviceIdBin, ideviceInfoBin: tools.ideviceInfoBin }),
      manualUdids,
      // WDA_DEVELOPMENT_TEAM / WDA_BUNDLE_ID are set by the desktop host only for its bundled, unsigned WebDriverAgent;
      // a bad value disables provisioning loudly below. Null (not undefined) so the manager does not fall back to process.env.
      wdaProcessManager: use.createWdaManager({
        wdaRepoPath: env.WDA_REPO_PATH,
        xcodebuildBin: tools.xcodebuildBin,
        developmentTeam: env.WDA_DEVELOPMENT_TEAM || null,
        bundleId: env.WDA_BUNDLE_ID || null,
        ownershipStore,
      }),
      iproxyManager: use.createIproxyManager({ bin: tools.iproxyBin, ownershipStore }),
      portReclaimer,
      ownershipStore,
      ownerServer: owner,
      iproxyBin: tools.iproxyBin,
      provisioningStorePath: env.DEVICE_PROVISIONING_STORE_PATH
        || path.join(here, "../../storage/device-provisioning.json"),
      derivedDataRoot: env.WDA_DERIVED_DATA_ROOT
        || path.join(here, "../../storage/wda-derived-data"),
      portRange: resolvePortRange(env),
      mjpegPortRange: resolveMjpegPortRange(env),
      pollIntervalMs: Number(env.PROVISION_POLL_INTERVAL_MS) || undefined,
      onDeviceListChanged,
    });
    // A clean stop removes the status file (a leftover file would describe a session that is over).
    if (typeof provisioner.stop === "function") {
      const stopProvisioner = provisioner.stop.bind(provisioner);
      provisioner.stop = async (...args) => {
        try { return await stopProvisioner(...args); } finally { removeStatusFile(ownershipPath); }
      };
    }
    provisioner.start();
    return provisioner;
  } catch (error) {
    console.error("Automatic WDA provisioning is disabled:", error.message);
    return null;
  }
}
