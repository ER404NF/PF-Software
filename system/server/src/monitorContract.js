const ADAPTER_LABELS = Object.freeze({
  mock: "Local simulation",
  wda: "Configured WebDriverAgent",
  unconfigured: "Detected iPhone without WDA",
});

export function monitorState({ adapter = "unconfigured", physicallyValidated = false, activeViewers = 0 } = {}) {
  const available = adapter === "mock" || adapter === "wda";
  return {
    available,
    state: available ? "available" : "unavailable",
    readOnly: true,
    claimsInputLease: false,
    refreshIntervalMs: available ? 2000 : null,
    activeViewers: Number.isInteger(activeViewers) && activeViewers >= 0 ? activeViewers : 0,
    adapter,
    environmentLabel: ADAPTER_LABELS[adapter] ?? "Unknown adapter",
    physicallyValidated: adapter === "wda" && physicallyValidated === true,
    validationState: adapter === "wda" ? (physicallyValidated ? "validated" : "pending") : "not-applicable",
    reason: available
      ? adapter === "mock"
        ? "Read-only frames are available from the local simulation adapter."
        : physicallyValidated
          ? "Read-only WDA monitoring is physically validated for this device."
          : "Read-only WDA frames are available; physical passive-capture acceptance is still pending."
      : "Configure this detected iPhone's WDA tunnel before live monitoring.",
  };
}
