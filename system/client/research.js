// Research review is independent of admin features and never sends device input.
const researchPanel = document.getElementById("research-panel");
const researchToggle = document.getElementById("research-toggle");
const researchAccount = document.getElementById("research-account");
const researchResults = document.getElementById("research-results");
const researchMessage = document.getElementById("research-message");
let researchEpoch = 0;

function researchReset() {
  researchEpoch++;
  researchPanel.hidden = true;
  researchToggle.setAttribute("aria-expanded", "false");
  researchAccount.replaceChildren();
  researchResults.replaceChildren();
  researchMessage.textContent = "";
}
window.addEventListener("operator-profile-changed", researchReset);

async function researchFetch(url, options) {
  const res = await fetch(url, options);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

function researchText(parent, tag, value) {
  const el = document.createElement(tag);
  el.textContent = value;
  parent.append(el);
  return el;
}

function safeEvidenceReference(account, reference) {
  if (typeof reference !== "string") return null;
  const prefix = `/api/research/${encodeURIComponent(account)}/evidence/`;
  if (!reference.startsWith(prefix)) return null;
  const evidenceId = reference.slice(prefix.length);
  return /^evidence-[0-9a-f-]+\.(?:png|jpg|webp)$/.test(evidenceId) ? reference : null;
}

function renderResearchRun(run, account, epoch) {
  const section = document.createElement("section");
  section.className = "research-run";
  researchText(section, "h3", `${run.platform} · ${run.createdAt}`);
  researchText(section, "p", run.overview);
  for (const candidate of run.candidates || []) {
    const card = document.createElement("article");
    card.className = "research-candidate";
    researchText(card, "h4", candidate.source_handle || candidate.sourceHandle || "Unknown source");
    researchText(card, "p", candidate.ai_summary || candidate.selection_reason || "No summary recorded.");
    if (candidate.text_extract) researchText(card, "p", candidate.text_extract);
    if (candidate.tags?.length) researchText(card, "p", `Tags: ${candidate.tags.join(", ")}`);
    if (candidate.score != null) researchText(card, "p", `Score: ${candidate.score}`);
    if (candidate.evidence_refs?.length) {
      const evidence = document.createElement("p");
      researchText(evidence, "span", "Evidence: ");
      let rendered = 0;
      for (const reference of candidate.evidence_refs) {
        const href = safeEvidenceReference(account, reference);
        if (!href) continue;
        if (rendered) researchText(evidence, "span", " · ");
        const link = researchText(evidence, "a", `View evidence ${rendered + 1}`);
        link.href = href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        rendered++;
      }
      if (rendered) card.append(evidence);
    }
    if (candidate.platform_actions?.length) {
      researchText(card, "p", `Recorded actions: ${candidate.platform_actions.map((a) => `${a.action} (${a.status || "unspecified"})`).join(", ")}`);
    }
    try {
      const url = new URL(candidate.canonical_url || candidate.url);
      if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) {
        const link = researchText(card, "a", "Open source");
        link.href = url.href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
      }
    } catch { /* A missing/unsafe source never becomes a clickable link. */ }
    const status = researchText(card, "p", `Review: ${candidate.review_state || candidate.status}`);
    const controls = document.createElement("div");
    for (const value of ["confirmed", "removed"]) {
      const button = researchText(controls, "button", value === "confirmed" ? "Confirm" : "Remove");
      button.type = "button";
      button.addEventListener("click", async () => {
        for (const b of controls.children) b.disabled = true;
        researchMessage.textContent = "Saving review…";
        try {
          const route = `/api/research/${encodeURIComponent(account)}/runs/${encodeURIComponent(run.id)}/candidates/${encodeURIComponent(candidate.id)}`;
          const result = await researchFetch(route, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: value }) });
          if (epoch !== researchEpoch) return;
          status.textContent = `Review: ${result.candidate.review_state || result.candidate.status}`;
          researchMessage.textContent = "Review saved.";
        } catch (error) {
          if (epoch === researchEpoch) researchMessage.textContent = error.message;
        } finally {
          for (const b of controls.children) b.disabled = false;
        }
      });
    }
    card.append(controls);
    section.append(card);
  }
  researchResults.append(section);
}

async function loadResearchRuns() {
  const account = researchAccount.value;
  if (!account) return;
  const epoch = ++researchEpoch;
  researchResults.replaceChildren();
  researchMessage.textContent = "Loading research…";
  try {
    const { runs } = await researchFetch(`/api/research/${encodeURIComponent(account)}/runs`);
    if (epoch !== researchEpoch) return;
    researchMessage.textContent = runs.length ? `${runs.length} research run(s).` : "No research recorded for this account yet.";
    for (const run of [...runs].reverse()) renderResearchRun(run, account, epoch);
  } catch (error) {
    if (epoch === researchEpoch) researchMessage.textContent = error.message;
  }
}

researchToggle.addEventListener("click", async () => {
  if (!researchPanel.hidden) return researchReset();
  researchPanel.hidden = false;
  researchToggle.setAttribute("aria-expanded", "true");
  const epoch = ++researchEpoch;
  researchMessage.textContent = "Loading assigned accounts…";
  try {
    const { accounts } = await researchFetch("/api/research");
    if (epoch !== researchEpoch) return;
    researchAccount.replaceChildren();
    for (const account of accounts) {
      const option = researchText(researchAccount, "option", `${account.workspaceId} / ${account.id}`);
      option.value = account.id;
    }
    if (accounts.length) await loadResearchRuns();
    else researchMessage.textContent = "No research accounts assigned. Ask an administrator to configure workspace access.";
  } catch (error) {
    if (epoch === researchEpoch) researchMessage.textContent = error.message;
  }
});
document.getElementById("research-close").addEventListener("click", researchReset);
document.getElementById("logout-button").addEventListener("click", researchReset);
document.getElementById("research-refresh").addEventListener("click", loadResearchRuns);
researchAccount.addEventListener("change", loadResearchRuns);
