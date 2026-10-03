(function publishProxyPoolController(root) {
  function createProxyPoolController({ elements, documentRef, requestJson, getProfileGeneration,
    requestActive, can, capabilities, formatDate, onPoolChanged = () => {} }) {
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
        label.textContent = `${proxy.flag ? `${proxy.flag} ` : ""}${proxy.label}`;
        const state = documentRef.createElement("span");
        state.className = `user-state ${proxy.leasedToDeviceId ? "approved" : "inactive"}`;
        state.textContent = proxy.leasedToDeviceId ? `Assigned to ${proxy.leasedToDeviceId}` : "Available";
        heading.append(label, state);
        const identity = documentRef.createElement("p");
        identity.className = "user-identity";
        identity.textContent = [proxy.provider, proxy.protocol, proxy.country].filter(Boolean).join(" · ");
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
          const testSaved = documentRef.createElement("button");
          testSaved.type = "button";
          testSaved.textContent = "Test Proxy";
          testSaved.addEventListener("click", () => void testSavedProxy(proxy, testSaved));
          card.append(testSaved);
          const remove = documentRef.createElement("button");
          remove.type = "button";
          remove.textContent = "Delete";
          remove.disabled = Boolean(proxy.leasedToDeviceId);
          remove.title = proxy.leasedToDeviceId ? "Release it from its assigned device first." : "";
          remove.addEventListener("click", () => void deleteSavedProxy(proxy, remove));
          card.append(remove);
        }
        poolList.append(card);
      }
    }

    function renderProviders(providers) {
      providerList.replaceChildren();
      const hasContent = providers.some(provider => provider.error || (provider.exits || []).length !== 0);
      providerEmpty.hidden = hasContent;
      providerEmpty.textContent = providers.length === 0
        ? "No proxy provider is configured."
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
      if (providerResult.status === "fulfilled") {
        renderProviders(Array.isArray(providerResult.value.body.providers) ? providerResult.value.body.providers : []);
      } else {
        providerList.replaceChildren();
        providerEmpty.hidden = false;
        providerEmpty.textContent = `Could not load provider exits: ${providerResult.reason.message}`;
      }
      return poolResult.status === "fulfilled" || providerResult.status === "fulfilled";
    }

    async function testSavedProxy(proxy, button) {
      const generation = getProfileGeneration();
      button.disabled = true;
      if (active(generation, capabilities.MANAGE_PROXY)) message.textContent = `Testing ${proxy.label}…`;
      try {
        const { body } = await requestJson(`/api/admin/proxies/${encodeURIComponent(proxy.id)}/test`, { method: "POST" });
        if (!active(generation, capabilities.MANAGE_PROXY)) return false;
        message.textContent = `${proxy.label} works through ${body.result.publicIpv4}`
          + (body.result.country ? ` (${body.result.country})` : "") + ` in ${body.result.latencyMs} ms.`;
        await refresh();
        return true;
      } catch (error) {
        if (!active(generation, capabilities.MANAGE_PROXY)) return false;
        message.textContent = error.message;
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
        message.textContent = error.message;
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
        message.textContent = `${provider.label} ${exit.id} ${body.exit.enabled ? "enabled" : "disabled"}. Phone routing was not applied or verified.`;
        await refresh();
        return true;
      } catch (error) {
        if (!active(generation, capabilities.MANAGE_PROXY)) return false;
        message.textContent = error.message;
        return false;
      } finally {
        button.disabled = false;
      }
    }

    async function createProxy(event) {
      event?.preventDefault?.();
      const generation = getProfileGeneration();
      message.textContent = "";
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
        message.textContent = `${body.proxy.label} added.`;
        createForm.reset();
        await refresh();
        return true;
      } catch (error) {
        fields.password = "";
        if (!active(generation, capabilities.MANAGE_PROXY)) return false;
        message.textContent = error.message;
        return false;
      } finally {
        fields.password = "";
        passwordInput.value = "";
        submit.disabled = false;
      }
    }

    async function testUnsavedProxy() {
      const generation = getProfileGeneration();
      message.textContent = "Testing proxy fields…";
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
        message.textContent = `Proxy works through ${body.result.publicIpv4}`
          + (body.result.country ? ` (${body.result.country})` : "") + ` in ${body.result.latencyMs} ms. You can add it now.`;
        return true;
      } catch (error) {
        fields.password = "";
        if (!active(generation, capabilities.MANAGE_PROXY)) return false;
        message.textContent = error.message;
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
      message.textContent = "";
      poolList.replaceChildren();
      poolEmpty.hidden = false;
      poolEmpty.textContent = unavailable ? "The proxy pool is not available for this role." : "No proxies have been added.";
      providerList.replaceChildren();
      providerEmpty.hidden = false;
      providerEmpty.textContent = "No proxy provider is configured.";
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
