import test from "node:test";
import assert from "node:assert/strict";
import { resolveDurableRepositoryConfig } from "../../src/durableRepositoryConfig.js";

test("durable repositories remain file-backed by default", () => {
  assert.deepEqual(resolveDurableRepositoryConfig({}), { sites: "file", requiresDatabase: false });
});

test("the sites domain can opt into PostgreSQL independently", () => {
  assert.deepEqual(resolveDurableRepositoryConfig({
    SITE_REPOSITORY_BACKEND: "postgres",
    DATABASE_URL: "postgres://configured",
  }), { sites: "postgres", requiresDatabase: true });
});

test("database-backed modes fail closed without DATABASE_URL", () => {
  assert.throws(
    () => resolveDurableRepositoryConfig({ SITE_REPOSITORY_BACKEND: "postgres" }),
    /require DATABASE_URL/,
  );
  assert.throws(
    () => resolveDurableRepositoryConfig({ CLOUD_API_ENABLED: "true" }),
    /require DATABASE_URL/,
  );
});

test("unknown repository backends fail startup instead of falling back to files", () => {
  assert.throws(
    () => resolveDurableRepositoryConfig({ SITE_REPOSITORY_BACKEND: "memory" }),
    /SITE_REPOSITORY_BACKEND must be either file or postgres/,
  );
});

