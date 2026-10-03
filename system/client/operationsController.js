(function publishOperationsController(root) {
  function createOperationsController({ links, documentRef, locationRef, historyRef,
    initialPanelId = "command-console-panel" }) {
    if (!Array.isArray(links) || !documentRef || !locationRef || !historyRef) {
      throw new TypeError("operations controller requires DOM dependencies");
    }
    let activePanelId = initialPanelId;

    function sync(allowed) {
      if (!allowed || typeof allowed.get !== "function") throw new TypeError("operations panel permissions must provide get()");
      const requestedHash = locationRef.hash.slice(1);
      if (allowed.get(requestedHash)) activePanelId = requestedHash;
      if (!allowed.get(activePanelId)) {
        activePanelId = links.map(link => link.dataset.operationsTarget).find(target => allowed.get(target)) ?? null;
      }
      for (const link of links) {
        const panel = documentRef.getElementById(link.dataset.operationsTarget);
        const available = Boolean(panel && allowed.get(link.dataset.operationsTarget));
        const active = available && link.dataset.operationsTarget === activePanelId;
        link.hidden = !available;
        link.setAttribute("aria-current", active ? "page" : "false");
        if (panel) panel.hidden = !active;
      }
      return activePanelId;
    }

    function select(panelId, allowed, { focus = true } = {}) {
      const link = links.find(candidate => candidate.dataset.operationsTarget === panelId);
      if (!link || !allowed.get(panelId)) return false;
      activePanelId = panelId;
      sync(allowed);
      historyRef.replaceState(null, "", `#${panelId}`);
      if (focus) documentRef.getElementById(panelId)?.focus({ preventScroll: true });
      return true;
    }

    return { sync, select, activePanel: () => activePanelId };
  }

  if (typeof module !== "undefined" && module.exports) module.exports = { createOperationsController };
  if (root) root.createOperationsController = createOperationsController;
})(typeof window !== "undefined" ? window : null);
