const DEFINITIONS = {
  D101: {
    name: "Physical iPhone disconnected", component: "device-discovery",
    sourceFile: "system/server/src/deviceProvisioner.js", sourceFunction: "_onDetach",
    severity: "error", retryable: true, automaticRecovery: "Wait for the phone to reconnect, then reprovision its runtime components.",
    operatorAction: "Check the USB cable or adapter and reconnect the iPhone.", safeState: "Control is unavailable; no device input is sent.",
    publicMessage: "The iPhone is no longer present in physical-device discovery.",
  },
  D102: {
    name: "iPhone discovery temporarily unavailable", component: "device-discovery",
    sourceFile: "system/server/src/deviceDiscovery.js", sourceFunction: "discoverIosDevicesResult",
    severity: "warning", retryable: true, automaticRecovery: "Retry physical-device discovery without detaching known phones.",
    operatorAction: "No immediate action is required. If this continues, check the iOS device tools on the Mac.",
    safeState: "Existing device and process state is retained until attachment can be checked again.",
    publicMessage: "PF-Software could not check which iPhones are attached.",
  },
  W201: {
    name: "WDA health check timed out", component: "wda-endpoint",
    sourceFile: "system/server/src/wdaDevice.js", sourceFunction: "checkReadiness",
    severity: "warning", retryable: true, automaticRecovery: "Retry the health check, then restart only the failed forwarding or WDA layer after repeated failures.",
    operatorAction: "Keep the iPhone unlocked. Use Retry Automatic Setup only if bounded automatic recovery fails.",
    safeState: "A single timeout degrades readiness but does not declare an attached healthy phone disconnected.",
    publicMessage: "WebDriverAgent did not answer before the health-check timeout.",
  },
  W202: {
    name: "WDA process exited", component: "wda-process",
    sourceFile: "system/server/src/deviceProvisioner.js", sourceFunction: "_onProcessExit",
    severity: "warning", retryable: true, automaticRecovery: "The WDA process supervisor restarts this phone independently with bounded backoff.",
    operatorAction: "No action is required unless automatic retries are exhausted.", safeState: "Control is degraded while WDA restarts.",
    publicMessage: "WebDriverAgent stopped and is being restarted.",
  },
  W203: {
    name: "WDA failed to start after repeated attempts", component: "wda-process",
    sourceFile: "system/server/src/deviceProvisioner.js", sourceFunction: "_onRestartLimitExceeded",
    severity: "error", retryable: true, automaticRecovery: "Automatic WDA restarts stopped after the bounded retry budget.",
    operatorAction: "Review the host diagnostics, resolve the reported signing, trust, or device issue, then retry automatic setup.",
    safeState: "Device control remains unavailable.", publicMessage: "WebDriverAgent failed to start after repeated attempts.",
  },
  W204: {
    name: "WDA endpoint unavailable", component: "wda-endpoint",
    sourceFile: "system/server/src/wdaDevice.js", sourceFunction: "checkReadiness",
    severity: "warning", retryable: true, automaticRecovery: "Retry and inspect WDA and USB-forwarding component state before restarting anything.",
    operatorAction: "Keep the phone connected and unlocked while PF-Software retries.",
    safeState: "Control is degraded until the endpoint responds repeatedly or recovery completes.",
    publicMessage: "PF-Software could not obtain a valid ready response from WebDriverAgent.",
  },
  W205: {
    name: "WDA requires an action on the iPhone", component: "wda-process",
    sourceFile: "system/server/src/deviceProvisioner.js", sourceFunction: "_onProcessExit",
    severity: "error", retryable: true,
    automaticRecovery: "Automatic restarts are paused because repeating the same launch cannot resolve a phone trust, Developer Mode, certificate, or signing prerequisite.",
    operatorAction: "Complete the action shown for this phone, then use Retry Automatic Setup.",
    safeState: "WDA and USB forwarding are stopped; device control remains unavailable.",
    publicMessage: "WebDriverAgent cannot start until a manual prerequisite is completed.",
  },
  I201: {
    name: "iproxy process stopped", component: "iproxy",
    sourceFile: "system/server/src/deviceProvisioner.js", sourceFunction: "_onProcessExit",
    severity: "warning", retryable: true, automaticRecovery: "Restart USB forwarding for this phone only.",
    operatorAction: "No action is required unless automatic retries are exhausted.", safeState: "Control is degraded while USB forwarding restarts.",
    publicMessage: "The USB forwarding process stopped and is being restarted.",
  },
  I202: {
    name: "WDA forwarding unavailable", component: "iproxy",
    sourceFile: "system/server/src/deviceProvisioner.js", sourceFunction: "_recoverEndpoint",
    severity: "warning", retryable: true, automaticRecovery: "Restart iproxy first, then recheck WDA before considering a WDA restart.",
    operatorAction: "No action is required while automatic recovery is running.", safeState: "Control is degraded during forwarding recovery.",
    publicMessage: "The phone and WDA process are present, but the forwarded WDA endpoint is unavailable.",
  },
  I203: {
    name: "iproxy failed to start after repeated attempts", component: "iproxy",
    sourceFile: "system/server/src/deviceProvisioner.js", sourceFunction: "_onRestartLimitExceeded",
    severity: "error", retryable: true, automaticRecovery: "Automatic iproxy restarts stopped after the bounded retry budget.",
    operatorAction: "Review host diagnostics, check the USB tools and cable, then retry automatic setup.",
    safeState: "Device control remains unavailable.", publicMessage: "USB forwarding failed to start after repeated attempts.",
  },
  R201: {
    name: "Automatic device recovery exhausted", component: "device-reconciler",
    sourceFile: "system/server/src/deviceProvisioner.js", sourceFunction: "_recoverEndpoint",
    severity: "error", retryable: true, automaticRecovery: "Bounded layer-specific recovery has stopped to avoid a restart loop.",
    operatorAction: "Unlock the phone, review Diagnostics, then use Retry Automatic Setup.",
    safeState: "Control remains unavailable until a verified recovery.", publicMessage: "Automatic recovery could not restore device control.",
  },
};

const NETWORK_ERRORS = [
  ["P101", "Proxy hostname invalid", "proxy-test", "validateProxy", "Enter a valid hostname or IP address."],
  ["P102", "Proxy DNS resolution failed", "proxy-test", "testProxy", "Check the proxy hostname and the Mac's DNS connection."],
  ["P103", "Proxy port unreachable", "proxy-test", "probeProxy", "Check the proxy port and provider allow-list."],
  ["P104", "Proxy connection refused", "proxy-test", "probeProxy", "Confirm the provider host and port are active."],
  ["P105", "Proxy connection timed out", "proxy-test", "probeProxy", "Check the host, port, firewall, and provider availability."],
  ["P106", "Proxy protocol mismatch", "proxy-test", "probeProxy", "Select the protocol supplied by the proxy provider."],
  ["P107", "Proxy authentication rejected", "proxy-test", "probeProxy", "Check the proxy username and password."],
  ["P108", "Malformed proxy configuration", "proxy-test", "validateProxy", "Correct the highlighted proxy fields and test again."],
  ["P109", "Proxy connected but Internet request failed", "proxy-test", "probeProxy", "Check whether the proxy permits external web traffic."],
  ["P110", "Unexpected proxy country", "proxy-test", "testProxy", "Use a proxy endpoint for the configured country or update the expected country."],
  ["P111", "Proxy test service unavailable", "proxy-test", "testProxy", "PF-Software will try another verification provider. Retry later if all providers are unavailable."],
  ["N201", "USB network interface could not be identified", "usb-network", "diffBridgeMembers", "Enroll one phone at a time and retry discovery."],
  ["N202", "USB network address unavailable", "usb-network", "discoverDeviceIp", "Generate traffic on the phone and retry IP discovery."],
  ["N203", "Stored USB network mapping is stale", "usb-network", "reconcileNetwork", "Allow PF-Software to rediscover this phone's interface and IP."],
  ["T201", "tun2proxy executable unavailable", "tunnel", "start", "Install or configure tun2proxy on the Mac host."],
  ["T202", "Proxy tunnel failed to start", "tunnel", "startRouting", "Review sanitized tunnel diagnostics and test the assigned proxy."],
  ["T203", "TUN interface was not created", "tunnel", "discoverTunPeer", "Check tun2proxy permissions and retry routing."],
  ["T204", "TUN peer unavailable", "tunnel", "discoverTunPeer", "Retry tunnel setup after checking the host network extension."],
  ["T205", "Proxy authentication stopped the tunnel", "tunnel", "startRouting", "Retest and correct the assigned proxy credentials."],
  ["T206", "Proxy tunnel exited unexpectedly", "tunnel", "checkHealth", "PF-Software will attempt a bounded per-device route rebuild."],
  ["T207", "Proxy tunnel restart limit reached", "tunnel", "checkHealth", "Review Diagnostics, test the proxy, and retry routing."],
  ["F201", "PF syntax validation failed", "pf", "_applyPfRuleset", "Review generated route diagnostics before retrying."],
  ["F202", "PF rules could not be loaded", "pf", "_applyPfRuleset", "Check the scoped pfctl sudo permission."],
  ["F203", "Expected device route missing", "pf", "checkHealth", "PF-Software will rebuild the private anchor for this device."],
  ["F204", "Traffic is not matching the device route", "pf", "checkHealth", "Generate phone traffic and inspect the device-specific PF counters."],
  ["F205", "PF permission failure", "pf", "PrivilegedOps", "Install the documented scoped sudoers rule for pfctl."],
  ["F206", "Stale PF state detected", "pf", "clearState", "Clear state for this phone's private USB IP and rebuild its route."],
  ["F207", "PF anchor unavailable", "pf", "inspectRules", "Check pfctl availability and the private Phone Farm anchor."],
  ["V201", "Network verification failed", "network-verification", "checkDevice", "PF-Software will retry with another verification provider."],
  ["V202", "Unexpected proxy exit IP", "network-verification", "checkDevice", "Test the assigned proxy and verify its expected exit."],
  ["V203", "Unexpected IPv6 route", "network-verification", "checkDevice", "Restore the IPv6 block before allowing phone Internet."],
  ["V204", "Protected network route lost", "network-verification", "reconcileRoute", "PF-Software will block direct fallback and rebuild this phone's protected route."],
];

for (const [code, name, component, sourceFunction, operatorAction] of NETWORK_ERRORS) {
  const sourceFile = component === "proxy-test" ? "system/server/src/proxyTester.js"
    : component === "usb-network" ? "system/server/src/usbNetworkMapper.js"
      : component === "network-verification" ? "system/server/src/networkVerifier.js"
        : component === "pf" ? "system/server/src/networkRoutingOrchestrator.js"
          : "system/server/src/tunManager.js";
  DEFINITIONS[code] = {
    name, component, sourceFile, sourceFunction, severity: "error", retryable: true,
    automaticRecovery: "Retry or reconcile only the affected network layer with bounded attempts.",
    operatorAction, safeState: "A proxy-required phone must not use an unverified direct route.", publicMessage: name,
  };
}

export const ERROR_CATALOG = Object.freeze(Object.fromEntries(
  Object.entries(DEFINITIONS).map(([code, value]) => [code, Object.freeze({
    code,
    diagnosticFields: [],
    ...value,
  })]),
));

export function diagnosticError(code, { why, operatorAction, technical = {}, at = new Date().toISOString() } = {}) {
  const definition = ERROR_CATALOG[code];
  if (!definition) throw new Error(`unknown diagnostic error code: ${code}`);
  return {
    code,
    name: definition.name,
    component: definition.component,
    sourceFile: definition.sourceFile,
    sourceFunction: definition.sourceFunction,
    location: `${definition.sourceFunction}() | ${definition.sourceFile}`,
    severity: definition.severity,
    retryable: definition.retryable,
    automaticRecovery: definition.automaticRecovery,
    operatorAction: operatorAction || definition.operatorAction,
    safeState: definition.safeState,
    publicMessage: definition.publicMessage,
    diagnosticFields: [...definition.diagnosticFields],
    why: why || definition.publicMessage,
    technical: sanitizeTechnical(technical),
    at,
  };
}

function sanitizeTechnical(value, depth = 0) {
  if (depth > 3 || value == null) return value == null ? null : "[omitted]";
  if (typeof value === "string") return value.slice(0, 500);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 20).map(item => sanitizeTechnical(item, depth + 1));
  if (typeof value !== "object") return String(value).slice(0, 500);
  const safe = {};
  for (const [key, item] of Object.entries(value)) {
    if (/password|secret|token|credential|authorization|cookie|udid/i.test(key)) continue;
    safe[key] = sanitizeTechnical(item, depth + 1);
  }
  return safe;
}

export function errorCatalog() {
  return Object.values(ERROR_CATALOG).map(definition => ({ ...definition }));
}
