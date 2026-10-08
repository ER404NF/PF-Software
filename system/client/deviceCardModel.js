(function publishDeviceCardModel(root) {
  // Pure decisions about what a fleet card shows, kept out of app.js so they can be tested without a
  // browser. The server decides which WDA actions are allowed and why not (lifecycleGuidance in the
  // provisioner); this only turns that into button states.

  const LIFECYCLE_LABELS = {
    stopped: { text: "Stopped", tone: "neutral" },
    starting: { text: "Starting", tone: "warning" },
    restarting: { text: "Restarting", tone: "warning" },
    enabled: { text: "Running, checking control", tone: "warning" },
    ready: { text: "Ready", tone: "healthy" },
    failed: { text: "Not working", tone: "error" },
    detached: { text: "Unplugged", tone: "neutral" },
    unmanaged: { text: "Not managed by Bodun", tone: "neutral" },
  };

  const PROVISIONING_OFF = "Automatic phone setup is turned off on this Mac.";
  const BUSY = "Another action on this phone is still running.";

  // While automatic setup is paused or still checking it is NOT turned off: a phone with no answer from the server says so.
  // (The server words this for each phone it knows; this covers a phone it gave no answer for.)
  function setupReason(setup) {
    if (setup?.state === "paused") return "Automatic phone setup is paused. See the notice at the top of this page.";
    if (setup?.state === "checking") return "Automatic phone setup is checking its earlier phone connections. Try again in a moment.";
    return PROVISIONING_OFF;
  }

  // The three actions the operator can take, plus the control check.
  //   lifecycle: device.wdaLifecycle from the server (null = automatic setup is off)
  //   inFlight:  the action currently running for this phone, if any
  function lifecycleButtons(lifecycle, inFlight = null, setup = null) {
    const offReason = setupReason(setup);
    const actions = [
      { key: "start", label: "Start WDA", can: "canStart", reason: "startReason" },
      { key: "stop", label: "Stop WDA", can: "canStop", reason: "stopReason" },
      { key: "restart", label: "Restart WDA", can: "canRestart", reason: "restartReason" },
    ];
    const buttons = actions.map(action => {
      if (!lifecycle) return { key: action.key, label: action.label, disabled: true, reason: offReason };
      if (inFlight) return { key: action.key, label: action.label, disabled: true, reason: BUSY };
      const allowed = lifecycle[action.can] === true;
      return { key: action.key, label: action.label, disabled: !allowed, reason: allowed ? null : (lifecycle[action.reason] || "Not available right now.") };
    });
    const check = {
      key: "check", label: "Check control",
      disabled: !lifecycle || lifecycle.managed === false || Boolean(inFlight),
      reason: !lifecycle ? offReason : lifecycle.managed === false ? lifecycle.startReason : inFlight ? BUSY : null,
    };
    // One line under the buttons explaining the first reason that applies (never several at once).
    const firstReason = buttons.concat(check).find(button => button.disabled && button.reason)?.reason ?? null;
    const reasons = [...buttons, check].filter(button => button.disabled && button.reason).map(button => ({ key: button.key, label: button.label, reason: button.reason }));
    return { buttons: [...buttons, check], reasons, note: !lifecycle || lifecycle.managed === false ? firstReason : null };
  }

  function describeLifecycle(lifecycle, setup = null) {
    if (!lifecycle && setup?.state === "paused") return { text: "Setup paused", tone: "warning" };
    if (!lifecycle && setup?.state === "checking") return { text: "Checking setup", tone: "warning" };
    if (!lifecycle) return { text: "Automatic setup is off", tone: "neutral" };
    return LIFECYCLE_LABELS[lifecycle.state] ?? { text: "Unknown", tone: "warning" };
  }

  // One status chip: one word, one colour. green = healthy, amber = in progress / not checked yet,
  // red = failed or blocked, gray = stopped or not set up on purpose.
  //   kind:  Device | Control | WDA | iproxy | Network | Proxy
  //   state: the server's state word (WDA: the process state)
  //   ctx:   { endpoint, recovery }  WDA's reachability check and the recovery state, which refine the word
  const upper = value => String(value ?? "UNKNOWN").toUpperCase().trim().replace(/\s+/g, "_");
  const chip = (text, tone, title) => ({ text, tone, title: title || text });

  function chipFor(kind, state, ctx = {}) {
    const value = upper(state);
    const endpoint = upper(ctx.endpoint);
    const recovery = upper(ctx.recovery);
    const operatorStopped = recovery === "OPERATOR_STOPPED";
    switch (kind) {
      case "Device":
        if (value === "CONNECTED" || value === "ATTACHED") return chip("Connected", "healthy");
        if (value === "DISCONNECTED" || value === "OFFLINE") return chip("Unplugged", "error", "The phone is not attached to this Mac.");
        return chip("Unchecked", "warning");
      case "Control":
        if (value === "READY") return chip("Ready", "healthy");
        // No verdict yet (just starting, or recovering) reads as "Checking"; only a phone that answered badly is "Slow".
        if (value === "DEGRADED") return ["SUSPECT", "DEGRADED"].includes(endpoint)
          ? chip("Slow", "warning", "The phone answered badly on the last check.")
          : chip("Checking", "warning", "Bodun is still checking that this phone answers.");
        if (value === "UNAVAILABLE") return operatorStopped
          ? chip("Off", "neutral", "Control was stopped on purpose.")
          : chip("Unavailable", "error", "Bodun cannot control this phone right now.");
        return chip("Unchecked", "warning");
      case "WDA": {
        if (value === "STOPPED") return chip("Stopped", "neutral", "WDA is stopped.");
        if (value === "STARTING") return chip("Starting", "warning");
        if (value === "RESTARTING") return chip("Restarting", "warning");
        if (value === "FAILED") return chip("Failed", "error", "WDA stopped working.");
        if (value === "RUNNING") {
          if (endpoint === "HEALTHY") return chip("Running", "healthy");
          if (endpoint === "FAILED") return chip("Not responding", "error", "WDA is running but is not answering.");
          return chip("Checking", "warning", "WDA is running; Bodun is checking that it answers.");
        }
        return chip("Unchecked", "warning");
      }
      case "iproxy":
        if (value === "RUNNING") return chip("Running", "healthy");
        if (value === "STOPPED") return chip("Stopped", "neutral", "The phone connection is stopped.");
        if (value === "STARTING") return chip("Starting", "warning");
        if (value === "RESTARTING") return chip("Restarting", "warning");
        if (value === "FAILED") {
          if (recovery === "BLOCKED_PORT") return chip("Blocked", "error", "Another program is using this phone's port.");
          if (recovery === "STOP_FAILED") return chip("Won't stop", "error", "The old process would not stop.");
          return chip("Failed", "error");
        }
        return chip("Unchecked", "warning");
      case "Network":
        if (value === "PROTECTED") return chip("Protected", "healthy");
        if (value === "UNCONFIGURED") return chip("Not set", "neutral", "No network route is set up for this phone.");
        if (value === "VERIFYING") return chip("Checking", "warning");
        if (value === "FAILED" || value === "MISMATCH") return chip("Failed", "error");
        return chip("Unchecked", "warning");
      case "Proxy":
        if (value === "HEALTHY") return chip("Healthy", "healthy");
        if (value === "FAILED") return chip("Failed", "error");
        return chip("Unchecked", "warning");
      default:
        return chip(String(state ?? "Unknown"), "warning");
    }
  }

  // The ONE answer to "what is this phone doing?", used for the card header, the access box and the footer so
  // they can never disagree. tone: healthy | warning | error | neutral.
  //   attention: true when the phone needs someone to do something (the card then shows a "Needs attention" block)
  function deviceStateSummary(device) {
    const health = device?.componentHealth || {};
    const recovery = upper(health.recovery);
    const attachment = upper(health.deviceAttachment);
    const access = device?.accessState;
    const summary = (headline, tone, attention = false) => ({ headline, tone, attention });
    if (access === "disconnected" || attachment === "DISCONNECTED") return summary("Unplugged", "error", true);
    if (recovery === "OPERATOR_STOPPED" || access === "wda_stopped") return summary("Control stopped", "neutral");
    if (recovery === "BLOCKED_PORT" || recovery === "STOP_FAILED") return summary("Needs attention", "error", true);
    if (access === "wda_user_action_required" || access === "wda_provisioning_error") return summary("Needs attention", "error", true);
    if (access === "wda_provisioning" || access === "wda_unconfigured") return summary("Setting up", "warning");
    if (device?.controllerMode && device.controllerMode !== "HUMAN") return summary("AI in control", "warning");
    if (device?.status === "offline") return summary("Not responding", "error", true);
    if (device?.status === "in-use") return summary("In use", "healthy");
    if (device?.consecutiveFailures > 0) return summary("Unstable", "warning");
    return summary("Ready", "healthy");
  }

  // Turns the diagnostics reply into plain lines an operator can read and paste. Internal details (file
  // locations, function names, stack traces) are left out; the phone's id is kept on one line, never split.
  const HIDDEN_DIAGNOSTIC_KEYS = /^(location|sourcefile|sourcefunction|stack|stacktrace|technical)$/i;
  const humanizeKey = key => String(key).replace(/([a-z])([A-Z])/g, (match, first, second) => `${first} ${second.toLowerCase()}`).replace(/[_-]+/g, " ").replace(/^./, letter => letter.toUpperCase());
  function formatDiagnostics(value, indent = "") {
    if (value === null || value === undefined) return "";
    if (typeof value !== "object") return `${indent}${value}`;
    const lines = [];
    const entries = Array.isArray(value) ? value.map((item, index) => [String(index + 1), item]) : Object.entries(value);
    for (const [key, item] of entries) {
      if (HIDDEN_DIAGNOSTIC_KEYS.test(key) || item === null || item === undefined || item === "") continue;
      const label = Array.isArray(value) ? `${key}.` : `${humanizeKey(key)}:`;
      if (typeof item === "object") {
        const inner = formatDiagnostics(item, `${indent}  `);
        if (inner) lines.push(`${indent}${label}`, inner);
      } else {
        lines.push(`${indent}${label} ${item}`);
      }
    }
    return lines.join("\n");
  }

  // ---- One name for a proxy: the phone card, the Proxy route dropdown and the Proxies tab all use these. ----

  // True when the label already says which country the proxy is in: a word that starts with the country code
  // ("US", "USA", "Italy" for IT) or the country's English name ("United States 1").
  function labelMentionsCountry(label, country) {
    const code = String(country).trim().toLowerCase();
    if (!code) return false;
    const words = String(label).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    if (words.some(word => word.startsWith(code))) return true;
    try {
      const countryName = new Intl.DisplayNames(["en"], { type: "region" }).of(code.toUpperCase());
      if (countryName && countryName.toLowerCase() !== code && String(label).toLowerCase().includes(countryName.toLowerCase())) return true;
    } catch { /* an unknown region code: nothing more to compare */ }
    return false;
  }

  // "US 1" stays "US 1"; "Premium 1" in Germany becomes "DE Premium 1"; a bare "1" becomes "US 1". The country is never
  // put in front of a label that already carries it.
  function proxyName(proxy) {
    const label = String(proxy?.label ?? "").trim();
    const country = String(proxy?.country ?? "").trim();
    if (!label) return country;
    if (!country) return label;
    if (/^\d+$/.test(label)) return `${country} ${label}`;
    return labelMentionsCountry(label, country) ? label : `${country} ${label}`;
  }

  const stripDomainEnding = name => String(name ?? "").trim().replace(/\.(com|io|net|co|org)$/i, "");
  const providerKey = name => stripDomainEnding(name).toLowerCase();

  // The provider the way the registry spells it when it knows it; otherwise as typed, without a domain ending
  // and with a capital first letter when it was typed in lower case. "oxylabs" and "Oxylabs.io" read the same.
  //   known: a Map of providerKey -> registry label (optional)
  function providerName(raw, known) {
    const typed = stripDomainEnding(raw);
    if (!typed) return "";
    const registry = known && typeof known.get === "function" ? known.get(providerKey(raw)) : null;
    if (registry) return registry;
    return typed === typed.toLowerCase() ? typed.charAt(0).toUpperCase() + typed.slice(1) : typed;
  }

  // The rows of a phone's collapsed error panel. `shownText` is what the "Needs attention" block above it already says;
  // a row whose text is already contained there is left out so nothing is said twice (without that block every row stays).
  const normaliseText = value => String(value ?? "").toLowerCase().replace(/\s+/g, " ").replace(/[.\s]+$/, "").trim();
  function errorRows(error, shownText = "") {
    const shown = normaliseText(shownText);
    return [
      ["Error name", error?.name],
      ["Why", error?.why || error?.publicMessage],
      ["How to fix", error?.operatorAction],
      ["Error code", error?.code],
      ["Safe state", error?.safeState],
    ].filter(([, value]) => {
      const text = normaliseText(value);
      return text !== "" && !(shown !== "" && shown.includes(text));
    });
  }

  // A message from the server shown as a sentence: capital letter first, full stop last (unless it already ends one).
  function asSentence(text) {
    const trimmed = String(text ?? "").trim();
    if (!trimmed) return "";
    const capitalised = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
    return /[.!?…)"'”]$/.test(capitalised) ? capitalised : `${capitalised}.`;
  }

  // What is open on each phone's card (an expanded Details row, the Diagnostics output, the control report). The fleet is
  // redrawn about every ten seconds and every redraw builds the cards again, so without this they would close by themselves.
  function createCardMemory() {
    const store = new Map();
    return {
      get: id => store.get(id) ?? {},
      update(id, patch) { store.set(id, { ...store.get(id), ...patch }); },
      clear(id) { store.delete(id); },
      prune(ids) { for (const id of [...store.keys()]) if (!ids.has(id)) store.delete(id); },
    };
  }

  // The fleet is redrawn about every ten seconds and every redraw builds all the cards again, which would drop a keyboard
  // user's place (focus falls back to the top of the page). captureFocus remembers which control had focus on which card
  // (its place among the card's controls and its name); restoreFocus gives focus back to that control after the redraw.
  const CARD_CONTROLS = "button, select, input, textarea, summary, a[href]";
  function controlName(element) { return element.getAttribute("aria-label") || element.textContent.trim() || element.id || ""; }
  function captureFocus(root, active) {
    if (!active || !root.contains(active)) return null;
    const card = active.closest("[data-device-id]");
    if (!card) return null;
    return { deviceId: card.dataset.deviceId, index: [...card.querySelectorAll(CARD_CONTROLS)].indexOf(active), name: controlName(active) };
  }
  function restoreFocus(root, saved) {
    if (!saved) return false;
    const card = [...root.querySelectorAll("[data-device-id]")].find(candidate => candidate.dataset.deviceId === saved.deviceId);
    if (!card) return false;
    const controls = [...card.querySelectorAll(CARD_CONTROLS)];
    const same = controls[saved.index];
    const named = same && controlName(same) === saved.name ? same : controls.find(element => controlName(element) === saved.name);
    // The control itself may be gone (Cancel disappears once the enrollment is cancelled): stay on the same phone.
    const target = named && !named.disabled ? named : controls.find(element => !element.disabled);
    if (!target) return false;
    target.focus({ preventScroll: true });
    return true;
  }

  // How many phone cards fit side by side: a card is at least 235px wide with an 18px gap, never more than four across,
  // never more columns than phones. A width of 0 (the page is hidden and has not been measured) assumes a wide window.
  const CARD_MIN_WIDTH = 235;
  const CARD_GAP = 18;
  function fleetColumnCount(phoneCount, availableWidth) {
    const wanted = Math.max(1, Math.min(Number(phoneCount) || 1, 4));
    if (!availableWidth || availableWidth <= 0) return wanted;
    const fitting = Math.max(1, Math.floor((availableWidth + CARD_GAP) / (CARD_MIN_WIDTH + CARD_GAP)));
    return Math.min(wanted, fitting);
  }

  // Where the phone's internet goes. The proxy assigned from the Proxies tab is the answer when there is one, so a
  // card can never say "No egress assigned" while the Proxies tab shows that phone with a proxy.
  function egressLabel(device, { proxyDisabled = false, knownProviders } = {}) {
    if (proxyDisabled) return "Proxy disabled";
    const proxy = device?.poolProxy;
    if (proxy) {
      const name = proxyName(proxy);
      const provider = providerName(proxy.provider, knownProviders);
      return provider && provider !== name ? `${name} (${provider})` : name || provider;
    }
    const network = device?.network;
    return network?.providerLabel || network?.gatewayLabel || network?.egress || "No egress assigned";
  }

  const exported = { lifecycleButtons, describeLifecycle, chipFor, deviceStateSummary, formatDiagnostics, errorRows, asSentence, createCardMemory, captureFocus, restoreFocus, egressLabel, fleetColumnCount, proxyName, providerName, providerKey, PROVISIONING_OFF, BUSY, LIFECYCLE_LABELS };
  if (typeof module !== "undefined" && module.exports) module.exports = exported;
  if (root) root.deviceCardModel = exported;
})(typeof window !== "undefined" ? window : null);
