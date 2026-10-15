export class DatabaseStartupError extends Error {
  constructor(code, message = "Database initialization is unavailable") {
    super(message);
    this.name = "DatabaseStartupError";
    this.code = code;
  }
}

export function createDatabaseStartupCoordinator({
  pool,
  initialize = async () => {},
  deadlineMs = Number(process.env.DATABASE_STARTUP_DEADLINE_MS) || 60_000,
  initialDelayMs = Number(process.env.DATABASE_STARTUP_RETRY_BASE_MS) || 250,
  maxDelayMs = Number(process.env.DATABASE_STARTUP_RETRY_MAX_MS) || 5_000,
  jitter = Math.random,
  now = Date.now,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  log = event => console.log(event),
} = {}) {
  if (!pool?.query) throw new TypeError("database startup coordinator requires a pool");
  if (typeof initialize !== "function") throw new TypeError("database startup coordinator requires initialize()");

  let operation = null;
  let timer = null;
  let rejectWait = null;
  let cancelled = false;
  let state = Object.freeze({ status: "waiting", code: "DATABASE_STARTUP_WAITING", attempt: 0 });

  function publish(status, code, attempt) {
    state = Object.freeze({ status, code, attempt });
    log(code);
  }

  function wait(ms) {
    return new Promise((resolve, reject) => {
      rejectWait = reject;
      timer = setTimeoutFn(() => { timer = null; rejectWait = null; resolve(); }, ms);
      if (cancelled) {
        clearTimeoutFn(timer);
        timer = null;
        rejectWait = null;
        reject(new DatabaseStartupError("DATABASE_STARTUP_CANCELLED"));
      }
    });
  }

  async function run() {
    const deadline = now() + deadlineMs;
    let attempt = 0;
    publish("waiting", "DATABASE_STARTUP_WAITING", attempt);
    while (!cancelled) {
      attempt += 1;
      try {
        await pool.query("SELECT 1");
        await initialize(pool);
        publish("ready", "DATABASE_STARTUP_READY", attempt);
        return state;
      } catch {
        if (cancelled) break;
        const remaining = deadline - now();
        if (remaining <= 0) {
          publish("timeout", "DATABASE_STARTUP_TIMEOUT", attempt);
          throw new DatabaseStartupError("DATABASE_STARTUP_TIMEOUT");
        }
        publish("retrying", "DATABASE_STARTUP_RETRY", attempt);
        const exponential = Math.min(maxDelayMs, initialDelayMs * (2 ** Math.max(0, attempt - 1)));
        const delay = Math.min(remaining, Math.max(1, Math.round(exponential * (0.75 + Math.max(0, Math.min(1, jitter())) * 0.5))));
        await wait(delay);
      }
    }
    publish("cancelled", "DATABASE_STARTUP_CANCELLED", attempt);
    throw new DatabaseStartupError("DATABASE_STARTUP_CANCELLED");
  }

  return {
    start() {
      if (!operation) operation = run();
      return operation;
    },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      if (timer) {
        clearTimeoutFn(timer);
        timer = null;
        const reject = rejectWait;
        rejectWait = null;
        reject?.(new DatabaseStartupError("DATABASE_STARTUP_CANCELLED"));
      }
      if (state.status !== "ready" && state.status !== "timeout") publish("cancelled", "DATABASE_STARTUP_CANCELLED", state.attempt);
    },
    status() { return state; },
  };
}
