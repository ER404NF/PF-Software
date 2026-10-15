import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.join(here, "../../src/index.js");

function startWithUnavailableDatabase() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [indexPath], {
      env: {
        ...process.env,
        PORT: "0",
        PHONE_FARM_LOCAL_DEV: "true",
        AUTO_DISCOVER_IOS_DEVICES: "false",
        CLOUD_API_ENABLED: "true",
        DATABASE_URL: "postgresql://127.0.0.1:1/unavailable",
        DATABASE_SSL: "false",
        DATABASE_CONNECT_TIMEOUT_MS: "100",
        DATABASE_STARTUP_DEADLINE_MS: "60000",
        DATABASE_STARTUP_RETRY_BASE_MS: "1000",
        SESSION_SECRET: "database-startup-http-lifecycle-test-secret",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`server did not expose liveness during database startup: ${stdout} ${stderr}`));
    }, 8_000);
    child.stdout.on("data", chunk => {
      stdout += chunk.toString();
      const match = stdout.match(/running at http:\/\/127\.0\.0\.1:(\d+)/);
      if (!match) return;
      clearTimeout(timeout);
      resolve({ child, origin: `http://127.0.0.1:${match[1]}` });
    });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`server exited before liveness (${code ?? signal}): ${stderr || stdout}`));
    });
  });
}

function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    child.once("exit", resolve);
    child.kill();
  });
}

test("health remains live while database startup gates readiness and application APIs", async () => {
  const { child, origin } = await startWithUnavailableDatabase();
  try {
    const health = await fetch(`${origin}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const readiness = await fetch(`${origin}/readyz`);
    assert.equal(readiness.status, 503);
    assert.equal((await readiness.json()).checks.database.status, "initializing");

    const application = await fetch(`${origin}/api/me`);
    assert.equal(application.status, 503);
    assert.equal((await application.json()).code, "DATABASE_STARTUP_WAITING");
  } finally {
    await stop(child);
  }
});
