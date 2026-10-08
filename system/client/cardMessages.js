(function publishCardMessages(root) {
  // The result of an action on one phone's card (Retry setup, Start WDA, Check network…) must appear
  // ON that card. The fleet is rebuilt on every update, so the text is kept here, per phone, and
  // handed to whichever card element currently exists. Successes fade after a while; an error stays
  // until the operator acts on that phone again (or leaves the page).
  const SUCCESS_TTL_MS = 30_000;
  const TONES = new Set(["success", "error", "info"]);

  function createCardMessages({
    successTtlMs = SUCCESS_TTL_MS,
    now = () => Date.now(),
    setTimeoutFn = (...args) => setTimeout(...args),
    clearTimeoutFn = (...args) => clearTimeout(...args),
  } = {}) {
    const messages = new Map();   // deviceId -> { text, tone, at }
    const timers = new Map();     // deviceId -> timer id
    const elements = new Map();   // deviceId -> Set of elements showing it

    function paintElement(element, message) {
      element.textContent = message?.text ?? "";
      if (element.dataset) element.dataset.tone = message?.tone ?? "";
      element.hidden = !message;
    }

    // Only elements that are still on the page are written to (a card that was replaced by a re-render is skipped).
    function paint(deviceId) {
      const message = messages.get(deviceId) ?? null;
      for (const element of elements.get(deviceId) ?? []) {
        if (element.isConnected !== false) paintElement(element, message);
      }
    }

    function clearTimer(deviceId) {
      if (timers.has(deviceId)) { clearTimeoutFn(timers.get(deviceId)); timers.delete(deviceId); }
    }

    const api = {
      show(deviceId, text, tone = "info") {
        if (!deviceId || typeof text !== "string" || !text) return api.clear(deviceId);
        const safeTone = TONES.has(tone) ? tone : "info";
        clearTimer(deviceId);
        messages.set(deviceId, { text, tone: safeTone, at: now() });
        if (safeTone === "success") {
          const timer = setTimeoutFn(() => { timers.delete(deviceId); api.clear(deviceId); }, successTtlMs);
          timer?.unref?.();
          timers.set(deviceId, timer);
        }
        paint(deviceId);
        return messages.get(deviceId);
      },
      // A new action on this phone starts: whatever was said before is no longer current.
      begin(deviceId, text = "", tone = "info") {
        return text ? api.show(deviceId, text, tone) : api.clear(deviceId);
      },
      get(deviceId) {
        return messages.get(deviceId) ?? null;
      },
      clear(deviceId) {
        clearTimer(deviceId);
        const had = messages.delete(deviceId);
        paint(deviceId);
        return had;
      },
      clearAll() {
        for (const deviceId of [...messages.keys()]) api.clear(deviceId);
      },
      // Binds a card's message element to this phone; the current message (if any) is shown at once.
      attach(deviceId, element) {
        if (!elements.has(deviceId)) elements.set(deviceId, new Set());
        const known = elements.get(deviceId);
        // A card is built before it is placed on the page, so the new element is not "connected" yet; the
        // ones left from the previous render are, by now, detached and can be forgotten.
        for (const old of [...known]) if (old.isConnected === false) known.delete(old);
        known.add(element);
        paintElement(element, messages.get(deviceId) ?? null);
        return element;
      },
    };
    return api;
  }

  const exported = { createCardMessages, SUCCESS_TTL_MS };
  if (typeof module !== "undefined" && module.exports) module.exports = exported;
  if (root) root.createCardMessages = createCardMessages;
})(typeof window !== "undefined" ? window : null);
