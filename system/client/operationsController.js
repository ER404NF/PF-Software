(function publishOperationsController(root) {
  // Which Operations panel is shown. Two rules keep it honest:
  //   1. A click always wins. `select()` never re-reads the browser address, so the address (which is only
  //      updated after the click) can never put the previous panel back.
  //   2. The address is read as an INPUT only when it holds a value this controller has not already seen:
  //      a link opened on page load, an address edited by hand, back/forward. Such a value is adopted once.
  function createOperationsController({ links, documentRef, locationRef, historyRef,
    initialPanelId = "command-console-panel" }) {
    if (!Array.isArray(links) || !documentRef || !locationRef || !historyRef) {
      throw new TypeError("operations controller requires DOM dependencies");
    }
    let activePanelId = initialPanelId;
    let lastSeenHash = null; // the last address value read or written; null until the first read
    const targetOf = link => link.dataset.operationsTarget;
    const currentAddress = () => locationRef.hash.slice(1);

    // Shows `activePanelId` and hides the rest. Never reads the address.
    function render(allowed) {
      for (const link of links) {
        const panel = documentRef.getElementById(targetOf(link));
        const available = Boolean(panel && allowed.get(targetOf(link)));
        const active = available && targetOf(link) === activePanelId;
        link.hidden = !available;
        link.setAttribute("aria-current", active ? "page" : "false");
        if (panel) panel.hidden = !active;
      }
    }

    function sync(allowed) {
      if (!allowed || typeof allowed.get !== "function") throw new TypeError("operations panel permissions must provide get()");
      const permitted = links.map(targetOf).filter(target => allowed.get(target));
      if (permitted.length === 0) {
        // Signed out (or no access at all): hide everything but remember the open panel and leave the address
        // unread, so signing back in returns to it and a waiting link is still honoured.
        render(allowed);
        return null;
      }
      const address = currentAddress();
      const isNewAddress = address !== "" && address !== lastSeenHash;
      let refused = false;
      if (isNewAddress) {
        if (allowed.get(address) && links.some(link => targetOf(link) === address)) activePanelId = address;
        else refused = true;
      }
      lastSeenHash = address;
      let fellBack = false;
      if (!allowed.get(activePanelId)) {
        activePanelId = permitted[0];
        fellBack = true;
      }
      // Keep the address truthful when a link was refused or the open panel had to change; never write an empty one.
      if ((refused || fellBack) && address !== "" && address !== activePanelId) {
        historyRef.replaceState(null, "", `#${activePanelId}`);
        lastSeenHash = currentAddress();
      }
      render(allowed);
      return activePanelId;
    }

    function select(panelId, allowed, { focus = true } = {}) {
      const link = links.find(candidate => targetOf(candidate) === panelId);
      if (!link || !allowed.get(panelId)) return false;
      activePanelId = panelId;
      historyRef.replaceState(null, "", `#${panelId}`);
      lastSeenHash = currentAddress(); // whatever the address now reads (also correct if it did not change)
      render(allowed);
      if (focus) documentRef.getElementById(panelId)?.focus({ preventScroll: true });
      return true;
    }

    return { sync, select, activePanel: () => activePanelId };
  }

  if (typeof module !== "undefined" && module.exports) module.exports = { createOperationsController };
  if (root) root.createOperationsController = createOperationsController;
})(typeof window !== "undefined" ? window : null);
