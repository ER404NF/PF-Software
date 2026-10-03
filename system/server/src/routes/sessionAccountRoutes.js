export function registerSessionAccountRoutes({ app, requireAuth, publicOperator, presenceStore, wss,
  broadcastPresence, logAuditBestEffort }) {
  if (!app?.post || !app?.get || typeof requireAuth !== "function" || typeof publicOperator !== "function"
    || !presenceStore?.removeSession || !wss?.clients || typeof broadcastPresence !== "function"
    || typeof logAuditBestEffort !== "function") throw new TypeError("session account routes require all authority owners");

  app.post("/api/logout", (req, res) => {
    const username = req.session.operator?.username ?? null;
    presenceStore.removeSession(req.sessionID);
    broadcastPresence();
    // Live authority is revoked synchronously before the durable session
    // destroy callback or best-effort audit work can delay completion.
    for (const ws of wss.clients) {
      if (ws.sessionId === req.sessionID) ws.invalidateSession();
    }
    req.session.destroy(error => {
      if (error) return res.status(500).json({ error: "Could not destroy session" });
      if (username) logAuditBestEffort({ operator: username, type: "logout" }, "Logout audit write");
      return res.json({ ok: true });
    });
  });

  app.get("/api/me", requireAuth, (req, res) => {
    res.json(publicOperator(req.currentOperator));
  });
}
