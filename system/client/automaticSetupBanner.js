(function publishAutomaticSetupBanner(root) {
  // The notice at the top of the Fleet page about automatic phone setup. Everyone sees what the server says (checking, or
  // paused with a reason). People the server marks as allowed also see "Check again". Its own answer is shown inside the
  // notice, never on the page-level message line. The words are written to the page only when they change, so a screen
  // reader announces a new status once, not on every update of the fleet.
  const CHECK_PATH = "/api/admin/automatic-setup/check";
  const REPAIR_PATH = "/api/admin/automatic-setup/repair-provisioning-state";
  const RESULT_FADE_MS = 10_000;

  function createAutomaticSetupBanner({
    banner, text, button, repairButton = null, result, requestJson,
    confirmFn = message => globalThis.confirm(message),
    setTimeoutFn = (...args) => setTimeout(...args), clearTimeoutFn = (...args) => clearTimeout(...args),
  }) {
    const buttonLabel = button.textContent || "Check again";
    let shown = null;
    let busy = false;
    let fade = null;

    const visible = status => status?.state === "paused" || status?.state === "checking"
      || status?.canRepairProvisioning === true;

    function clearResult() {
      if (fade !== null) { clearTimeoutFn(fade); fade = null; }
      if (result.textContent) result.textContent = "";
    }

    function showResult(message) {
      clearResult();
      result.textContent = message;
      fade = setTimeoutFn(() => { fade = null; result.textContent = ""; }, RESULT_FADE_MS);
      fade?.unref?.();
    }

    function update(status) {
      if (!status || typeof status !== "object") { // an older hub sends no status, or the page is being cleared: show nothing
        shown = null;
        banner.hidden = true;
        text.textContent = "";
        button.hidden = true;
        if (repairButton) repairButton.hidden = true;
        clearResult();
        return;
      }
      banner.hidden = !visible(status);
      banner.dataset.state = status.state;
      if (!shown || shown.code !== status.code || shown.message !== status.message) {
        shown = { code: status.code, message: status.message };
        text.textContent = status.message;
        clearResult();
      }
      button.hidden = !(visible(status) && status.canCheckAgain === true);
      button.setAttribute("aria-disabled", String(busy));
      if (repairButton) {
        repairButton.hidden = status.canRepairProvisioning !== true;
        repairButton.setAttribute("aria-disabled", String(busy));
      }
    }

    async function checkAgain() {
      if (busy) return;
      busy = true;
      // aria-disabled, not disabled: a disabled button loses keyboard focus, so a keyboard user would lose their place.
      button.setAttribute("aria-disabled", "true");
      button.textContent = "Checking…";
      clearResult();
      try {
        const { body } = await requestJson(CHECK_PATH, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
        showResult(body?.status?.state === "running"
          ? "Checked. Automatic phone setup is running."
          : "Checked. Automatic phone setup is still paused.");
      } catch (error) {
        showResult(error?.message || "The check could not be run. Try again.");
      } finally {
        busy = false;
        button.textContent = buttonLabel;
        button.setAttribute("aria-disabled", "false");
      }
    }

    async function repair() {
      if (busy || !repairButton) return;
      if (!confirmFn("Repair the saved phone setup? Valid phone records will be preserved and damaged records will be quarantined.")) return;
      busy = true;
      repairButton.setAttribute("aria-disabled", "true");
      repairButton.textContent = "Repairing…";
      clearResult();
      try {
        let { body } = await requestJson(REPAIR_PATH, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
        });
        if (body?.manualRepairRequired === true && body?.reason === "destructive_reset_required") {
          const approved = confirmFn("The saved setup cannot be read record-by-record. Reset all saved phone setup data? The original file will be retained locally for recovery.");
          if (!approved) {
            showResult("No data was changed. A full reset still requires confirmation.");
            return;
          }
          ({ body } = await requestJson(REPAIR_PATH, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ confirmDestructiveReset: true }),
          }));
        }
        showResult(body?.repaired
          ? `Repair complete. Preserved ${body.preservedCount ?? 0}; quarantined ${body.quarantinedCount ?? 0}.`
          : "The saved phone setup did not need repair.");
      } catch (error) {
        showResult(error?.message || "The saved phone setup could not be repaired.");
      } finally {
        busy = false;
        repairButton.textContent = "Repair saved phone setup";
        repairButton.setAttribute("aria-disabled", "false");
      }
    }

    button.addEventListener("click", checkAgain);
    repairButton?.addEventListener("click", repair);
    return { update, checkAgain, repair };
  }

  root.createAutomaticSetupBanner = createAutomaticSetupBanner;
})(typeof window !== "undefined" ? window : globalThis);
