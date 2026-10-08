(function publishProxyPoolController(root) {
  function createProxyPoolController({ elements, documentRef, requestJson, getProfileGeneration,
    requestActive, can, capabilities, formatDate, onPoolChanged = () => {}, deviceLabel = id => id }) {
    if (!elements || !documentRef || typeof requestJson !== "function"
      || typeof getProfileGeneration !== "function" || typeof requestActive !== "function"
      || typeof can !== "function" || !capabilities || typeof formatDate !== "function"
      || typeof onPoolChanged !== "function") {
      throw new TypeError("proxy pool controller requires all dependencies");
    }
    const { refreshButton, createForm, providerInput, protocolInput, hostInput, portInput,
      usernameInput, passwordInput, countryInput, labelInput, testButton, message, poolList,
      poolEmpty, providerList, providerEmpty } = elements;
    let pool = [];
    let loaded = false;
    // Provider names the registry knows (keyed the way the shared names key them), so a provider is spelled the same
    // on the card, in the dropdown and here. The shared functions live in deviceCardModel.js, which loads first.
    const providerLabels = new Map();
    const NO_PROVIDER_INVENTORY = "No separate provider inventory is connected. The proxies above are used directly.";

    // The result line keeps its height (so the list below never jumps) and carries a tone for success or error.
    function say(text, tone = "") {
      message.textContent = text;
      if (message.dataset) message.dataset.tone = text ? tone : "";
    }

    function active(generation, capability) {
      return requestActive(generation, capability);
    }

    function setPool(nextPool, isLoaded) {
      pool = nextPool;
      loaded = isLoaded;
      onPoolChanged();
    }

    function renderPool(proxies) {
      pool = proxies;
      poolList.replaceChildren();
      poolEmpty.hidden = proxies.length !== 0;
      const mayManage = can(capabilities.MANAGE_PROXY);
      for (const proxy of proxies) {
        const card = documentRef.createElement("article");
        card.className = "user-card";
        const heading = documentRef.createElement("div");
        heading.className = "user-card-heading";
        const label = documentRef.createElement("strong");
        label.textContent = `${proxy.flag ? `${proxy.flag} ` : ""}${root.deviceCardModel.proxyName(proxy)}`;
        const state = documentRef.createElement("span");
        // Assigned is green and Available is a calm gray; neither is ever red.
        state.className = `user-state ${proxy.leasedToDeviceId ? "approved" : "neutral"}`;
        state.textContent = proxy.leasedToDeviceId ? `Assigned to ${deviceLabel(proxy.leasedToDeviceId)}` : "Available";
        heading.append(label, state);
        const identity = documentRef.createElement("p");
        identity.className = "user-identity";
        identity.textContent = [root.deviceCardModel.providerName(proxy.provider, providerLabels), proxy.protocol, proxy.country].filter(Boolean).join(" · ");
        card.append(heading, identity);
        if (proxy.health) {
          const health = documentRef.createElement("p");
          health.className = "user-identity";
          health.textContent = proxy.health.status === "healthy"
            ? `Tested ${formatDate(proxy.health.checkedAt)} · ${proxy.health.publicIpv4 || "IP unavailable"}`
              + (proxy.health.country ? ` · ${proxy.health.country}` : "")
              + (Number.isFinite(proxy.health.latencyMs) ? ` · ${proxy.health.latencyMs} ms` : "")
            : `Test failed ${formatDate(proxy.health.checkedAt)} · ${proxy.health.errorCode || "P111"} ${proxy.health.errorName || ""}`;
          card.append(health);
        }
        if (mayManage) {
          const row = documentRef.createElement("div");
          row.className = "proxy-action-row";
          const testSaved = documentRef.createElement("button");
          testSaved.type = "button";
          testSaved.textContent = "Test Proxy";
          testSaved.addEventListener("click", () => void testSavedProxy(proxy, testSaved));
          const remove = documentRef.createElement("button");
          remove.type = "button";
          remove.textContent = "Delete";
          remove.disabled = Boolean(proxy.leasedToDeviceId);
          remove.addEventListener("click", () => void deleteSavedProxy(proxy, remove));
          row.append(testSaved, remove);
          card.append(row);
          if (proxy.leasedToDeviceId) {
            // The reason is written next to the button, not hidden in a tooltip.
            const reason = documentRef.createElement("p");
            reason.className = "proxy-reason";
            reason.id = `proxy-reason-${proxy.id}`;
            reason.textContent = `Can't delete while it is assigned to ${deviceLabel(proxy.leasedToDeviceId)}. Release it from that phone first.`;
            remove.setAttribute("aria-describedby", reason.id);
            card.append(reason);
          }
        }
        poolList.append(card);
      }
    }

    function renderProviders(providers) {
      providerList.replaceChildren();
      const hasContent = providers.some(provider => provider.error || (provider.exits || []).length !== 0);
      providerEmpty.hidden = hasContent;
      for (const provider of providers) if (provider.label) providerLabels.set(root.deviceCardModel.providerKey(provider.label), provider.label);
      providerEmpty.textContent = providers.length === 0
        ? NO_PROVIDER_INVENTORY
        : "Configured providers have not reported any exits.";
      const mayManage = can(capabilities.MANAGE_PROXY);
      for (const provider of providers) {
        if (provider.error) {
          const card = documentRef.createElement("article");
          card.className = "user-card";
          const heading = documentRef.createElement("strong");
          heading.textContent = provider.label;
          const error = documentRef.createElement("p");
          error.className = "user-identity";
          error.textContent = provider.error.message || "Provider inventory is unavailable.";
          card.append(heading, error);
          providerList.append(card);
          continue;
        }
        for (const exit of provider.exits || []) {
          const card = documentRef.createElement("article");
          card.className = "user-card";
          const heading = documentRef.createElement("div");
          heading.className = "user-card-heading";
          const label = documentRef.createElement("strong");
          label.textContent = `${provider.label} · ${exit.id}`;
          const state = documentRef.createElement("span");
          state.className = `user-state ${exit.enabled && exit.health?.status === "healthy" ? "active" : "inactive"}`;
          state.textContent = exit.enabled ? exit.health?.status || "unknown" : "disabled";
          heading.append(label, state);
          const detail = documentRef.createElement("p");
          detail.className = "user-identity";
          detail.textContent = `${exit.region} · ${exit.availableCapacity}/${exit.capacity} capacity available · ${exit.activeLeases} active leases`;
          const routing = documentRef.createElement("p");
          routing.className = "user-identity";
          routing.textContent = "Control plane only — phone routing is not applied or verified here.";
          card.append(heading, detail, routing);
          if (mayManage) {
            const toggle = documentRef.createElement("button");
            toggle.type = "button";
            toggle.textContent = exit.enabled ? "Disable exit" : "Enable exit";
            toggle.setAttribute("aria-label", `${toggle.textContent} ${exit.id} on ${provider.label}`);
            toggle.addEventListener("click", () => void toggleProviderExit(provider, exit, toggle));
            card.append(toggle);
          }
          providerList.append(card);
        }
      }
    }

    async function refresh() {
      if (!can(capabilities.VIEW_PROXY_POOL)) return false;
      const generation = getProfileGeneration();
      const [poolResult, providerResult] = await Promise.allSettled([
        requestJson("/api/admin/proxies"),
        requestJson("/api/admin/proxy-providers"),
      ]);
      if (!active(generation, capabilities.VIEW_PROXY_POOL)) return false;
      if (providerResult.status === "fulfilled") {
        renderProviders(Array.isArray(providerResult.value.body.providers) ? providerResult.value.body.providers : []);
      } else {
        providerList.replaceChildren();
        providerEmpty.hidden = false;
        providerEmpty.textContent = `Could not load provider exits: ${providerResult.reason.message}`;
      }
      if (poolResult.status === "fulfilled") {
        renderPool(Array.isArray(poolResult.value.body.proxies) ? poolResult.value.body.proxies : []);
        loaded = true;
        onPoolChanged();
      } else {
        setPool([], false);
        poolList.replaceChildren();
        poolEmpty.hidden = false;
        poolEmpty.textContent = `Could not load the proxy pool: ${poolResult.reason.message}`;
      }
      return poolResult.status === "fulfilled" || providerResult.status === "fulfilled";
    }

    async function testSavedProxy(proxy, button) {
      const generation = getProfileGeneration();
      button.disabled = true;
      if (active(generation, capabilities.MANAGE_PROXY)) say(`Testing ${proxy.label}…`, "info");
      try {
        const { body } = await requestJson(`/api/admin/proxies/${encodeURIComponent(proxy.id)}/test`, { method: "POST" });
        if (!active(generation, capabilities.MANAGE_PROXY)) return false;
        say(`${proxy.label} works through ${body.result.publicIpv4}`
          + (body.result.country ? ` (${body.result.country})` : "") + ` in ${body.result.latencyMs} ms.`, "success");
        await refresh();
        return true;
      } catch (error) {
        if (!active(generation, capabilities.MANAGE_PROXY)) return false;
        say(error.message, "error");
        await refresh();
        return false;
      } finally {
        button.disabled = false;
      }
    }

    async function deleteSavedProxy(proxy, button) {
      const generation = getProfileGeneration();
      button.disabled = true;
      try {
        await requestJson(`/api/admin/proxies/${encodeURIComponent(proxy.id)}`, { method: "DELETE" });
        if (!active(generation, capabilities.MANAGE_PROXY)) return false;
        await refresh();
        return true;
      } catch (error) {
        if (!active(generation, capabilities.MANAGE_PROXY)) return false;
        say(error.message, "error");
        return false;
      } finally {
        button.disabled = Boolean(proxy.leasedToDeviceId);
      }
    }

    async function toggleProviderExit(provider, exit, button) {
      const generation = getProfileGeneration();
      button.disabled = true;
      try {
        const { body } = await requestJson(`/api/admin/proxy-providers/${encodeURIComponent(provider.id)}/exits/${encodeURIComponent(exit.id)}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: !exit.enabled }),
        });
        if (!active(generation, capabilities.MANAGE_PROXY)) return false;
        say(`${provider.label} ${exit.id} ${body.exit.enabled ? "enabled" : "disabled"}. Phone routing was not applied or verified.`, "success");
        await refresh();
        return true;
      } catch (error) {
        if (!active(generation, capabilities.MANAGE_PROXY)) return false;
        say(error.message, "error");
        return false;
      } finally {
        button.disabled = false;
      }
    }

    async function createProxy(event) {
      event?.preventDefault?.();
      const generation = getProfileGeneration();
      say("");
      const submit = createForm.querySelector('button[type="submit"]');
      submit.disabled = true;
      const fields = {
        provider: providerInput.value, protocol: protocolInput.value, host: hostInput.value,
        port: Number(portInput.value), username: usernameInput.value, password: passwordInput.value,
        country: countryInput.value, label: labelInput.value,
      };
      passwordInput.value = "";
      try {
        const { body } = await requestJson("/api/admin/proxies", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fields),
        });
        fields.password = "";
        if (!active(generation, capabilities.MANAGE_PROXY)) return false;
        say(`${body.proxy.label} added.`, "success");
        createForm.reset();
        await refresh();
        return true;
      } catch (error) {
        fields.password = "";
        if (!active(generation, capabilities.MANAGE_PROXY)) return false;
        say(error.message, "error");
        return false;
      } finally {
        fields.password = "";
        passwordInput.value = "";
        submit.disabled = false;
      }
    }

    async function testUnsavedProxy() {
      // Point at the first empty or invalid field (as Add proxy does) instead of sending a request that cannot work.
      const unusable = [protocolInput, hostInput, portInput, usernameInput, passwordInput, countryInput]
        .find(input => typeof input.checkValidity === "function" && !input.checkValidity());
      if (unusable) {
        unusable.reportValidity();
        return false;
      }
      const generation = getProfileGeneration();
      say("Testing proxy fields…", "info");
      testButton.disabled = true;
      const fields = {
        protocol: protocolInput.value, host: hostInput.value, port: Number(portInput.value),
        username: usernameInput.value, password: passwordInput.value, country: countryInput.value,
      };
      passwordInput.value = "";
      try {
        const { body } = await requestJson("/api/admin/proxies/test", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fields),
        });
        fields.password = "";
        if (!active(generation, capabilities.MANAGE_PROXY)) return false;
        say(`Proxy works through ${body.result.publicIpv4}`
          + (body.result.country ? ` (${body.result.country})` : "") + ` in ${body.result.latencyMs} ms. You can add it now.`, "success");
        return true;
      } catch (error) {
        fields.password = "";
        if (!active(generation, capabilities.MANAGE_PROXY)) return false;
        say(error.message, "error");
        return false;
      } finally {
        fields.password = "";
        passwordInput.value = "";
        testButton.disabled = false;
      }
    }

    function clear({ unavailable = false } = {}) {
      pool = [];
      loaded = false;
      createForm.reset();
      passwordInput.value = "";
      say("");
      poolList.replaceChildren();
      poolEmpty.hidden = false;
      poolEmpty.textContent = unavailable ? "The proxy pool is not available for this role." : "No proxies have been added.";
      providerList.replaceChildren();
      providerEmpty.hidden = false;
      providerEmpty.textContent = NO_PROVIDER_INVENTORY;
      onPoolChanged();
    }

    createForm.addEventListener("submit", event => void createProxy(event));
    testButton.addEventListener("click", () => void testUnsavedProxy());
    refreshButton.addEventListener("click", () => void refresh());

    return {
      refresh,
      clear,
      isLoaded: () => loaded,
      getPool: () => pool,
      getProviderLabels: () => providerLabels,
      renderPool,
      renderProviders,
      createProxy,
      testUnsavedProxy,
      testSavedProxy,
      deleteSavedProxy,
      toggleProviderExit,
    };
  }

  root.createProxyPoolController = createProxyPoolController;
  if (typeof module !== "undefined" && module.exports) module.exports = { createProxyPoolController };
})(typeof window !== "undefined" ? window : globalThis);
