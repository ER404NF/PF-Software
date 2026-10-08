// One shutdown path for SIGTERM/SIGINT, shared by the server and the site agent.
//
// The old handler called `server.close(callback)` and ran the cleanup (which stops every managed
// iproxy/WebDriverAgent process) only from that callback. `close` waits for every open connection —
// and an operator's browser holds WebSockets open — so the callback could be delayed until a hard
// timeout that exited WITHOUT cleaning up, leaving the phones' processes behind.
//
// Now: cleanup starts first, then idle and open connections are dropped, and the hard stop only
// reports failure if cleanup really had not finished.
export function createShutdownHandler({
  server = null,
  cleanupRuntime,
  exit = code => process.exit(code),
  hardStopMs = 8000,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  log = () => {},
} = {}) {
  if (typeof cleanupRuntime !== "function") throw new Error("a cleanup function is required");
  let started = false;
  return function handleSignal() {
    if (started) return;
    started = true;
    let finished = false;
    const hardStop = setTimeoutFn(() => {
      log(finished ? "shutdown finished" : "shutdown hard stop reached before cleanup finished");
      exit(finished ? 0 : 1);
    }, hardStopMs);
    hardStop?.unref?.();
    // Called synchronously, so the first stop requests are issued before anything else happens.
    let cleanup;
    try { cleanup = Promise.resolve(cleanupRuntime()); } catch (error) { cleanup = Promise.reject(error); }
    try {
      server?.closeAllConnections?.();
      server?.close?.();
    } catch (error) {
      log(`closing the server failed: ${error?.message || error}`);
    }
    cleanup
      .catch(error => log(`cleanup failed: ${error?.message || error}`))
      .finally(() => {
        finished = true;
        clearTimeoutFn(hardStop);
        exit(0);
      });
  };
}
