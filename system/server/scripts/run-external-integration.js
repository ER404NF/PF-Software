import { spawnSync } from "node:child_process";
import pg from "pg";
import { createRedisClient } from "../src/redis/client.js";
import { runExternalIntegration } from "../src/externalIntegrationRunner.js";

async function probePostgres(url) {
  const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 2000, max: 1 });
  try { await pool.query("SELECT 1"); }
  finally { await pool.end().catch(() => {}); }
}

async function probeRedis(url) {
  const client = createRedisClient({ url, connectTimeout: 2000, maxRetriesPerRequest: 0 });
  try {
    await client.ping();
  } finally {
    client.disconnect();
  }
}

const kind = process.argv[2];
const result = await runExternalIntegration({
  kind,
  probe: kind === "postgres" ? probePostgres : probeRedis,
  run: files => spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...files], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  }).status ?? 1,
});

if (!result.ok) console.error(`External ${kind} integration did not run: ${result.category}.`);
process.exitCode = result.exitCode;
