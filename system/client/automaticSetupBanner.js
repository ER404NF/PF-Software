(function publishAutomaticSetupBanner(root) {
  // The notice at the top of the Fleet page about automatic phone setup. Everyone sees what the server says (checking, or
  // paused with a reason). People the server marks as allowed also see "Check again". Its own answer is shown inside the
  // notice, never on the page-level message line. The words are written to the page only when they change, so a screen
  // reader announces a new status once, not on every update of the fleet.
  const CHECK_PATH = "/api/admin/automatic-setup/check";
  const RESULT_FADE_MS = 10_000;

  function createAutomaticSetupBanner({
    banner, text, button, result, requestJson,
    setTimeoutFn = (...args) => setTimeout(...args), clearTimeoutFn = (...args) => clearTimeout(...args),
  }) {
    const buttonLabel = button.textContent || "Check again";
    let shown = null;
    let busy = false;
    let fade = null;

    const visible = status => status?.state === "paused" || status?.state === "checking";

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

    button.addEventListener("click", checkAgain);
    return { update, checkAgain };
  }

  root.createAutomaticSetupBanner = createAutomaticSetupBanner;
})(typeof window !== "undefined" ? window : globalThis);
