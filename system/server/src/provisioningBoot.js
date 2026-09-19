// Starts automatic WebDriverAgent provisioning (find USB iPhones, build/run WDA on
// each, forward its ports). Shared by the full server and by the site agent, so a
// remote site's Mac mini provisions phones exactly like a single-machine install.
//
// Opt-in (AUTO_PROVISION_WDA=true). Manually pinned devices.config.json WDA entries
// are left untouched: only UDIDs with no explicit config entry are provisioned.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverIosDevices } from "./deviceDiscovery.js";
import { runHostPreflight } from "./hostPreflight.js";
import { resolvePortRange, resolveMjpegPortRange } from "./portAllocator.js";
import { WdaProcessManager } from "./wdaProcessManager.js";
import { IProxyManager } from "./iproxyManager.js";
import { DeviceProvisioner } from "./deviceProvisioner.js";

const here = path.dirname(fileURLToPath(import.meta.url));

// Everything is read from the `env` that is passed in - never from the global process.env - so a caller that supplies
// its own environment (the desktop host, a test, the site agent) gets exactly the tools and signing settings it named.
// `deps` exists so a test can observe what would be used without running Xcode.
const REAL = {
  runPreflight: runHostPreflight,
  discover: discoverIosDevices,
  createWdaManager: options => new WdaProcessManager(options),
  createIproxyManager: options => new IProxyManager(options),
  createProvisioner: options => new DeviceProvisioner(options),
};

// Returns the running provisioner, undefined when provisioning is not enabled, or
// null when it was enabled but could not start (the reason is logged loudly).
export function startAutoProvisioning({ env = process.env, devices, manualUdids, onDeviceListChanged = () => {}, deps = {} }) {
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
    const provisioner = use.createProvisioner({
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
      }),
      iproxyManager: use.createIproxyManager({ bin: tools.iproxyBin }),
      provisioningStorePath: env.DEVICE_PROVISIONING_STORE_PATH
        || path.join(here, "../../storage/device-provisioning.json"),
      derivedDataRoot: env.WDA_DERIVED_DATA_ROOT
        || path.join(here, "../../storage/wda-derived-data"),
      portRange: resolvePortRange(env),
      mjpegPortRange: resolveMjpegPortRange(env),
      pollIntervalMs: Number(env.PROVISION_POLL_INTERVAL_MS) || undefined,
      onDeviceListChanged,
    });
    provisioner.start();
    return provisioner;
  } catch (error) {
    console.error("Automatic WDA provisioning is disabled:", error.message);
    return null;
  }
}
