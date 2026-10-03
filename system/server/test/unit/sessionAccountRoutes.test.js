import test from "node:test";
import assert from "node:assert/strict";
import { registerSessionAccountRoutes } from "../../src/routes/sessionAccountRoutes.js";

function fixture() {
  const routes = new Map();
  const app = { post(path, ...handlers) { routes.set(`POST ${path}`, handlers); },
    get(path, ...handlers) { routes.set(`GET ${path}`, handlers); } };
  const calls = [];
  const socket = { sessionId: "session-1", invalidateSession() { calls.push("socket-revoked"); } };
  registerSessionAccountRoutes({ app, requireAuth: (_req, _res, next) => next(), publicOperator: value => ({ username: value.username }),
    presenceStore: { removeSession: id => calls.push(`presence:${id}`) }, wss: { clients: new Set([socket]) },
    broadcastPresence: () => calls.push("broadcast"), logAuditBestEffort: event => calls.push(`audit:${event.type}`) });
  return { routes, calls };
}

test("logout revokes live authority before session destruction and audits only after commit", () => {
  const { routes, calls } = fixture();
  const req = { sessionID: "session-1", session: { operator: { username: "va" },
    destroy(callback) { calls.push("destroy"); callback(null); } } };
  const res = { json(body) { calls.push(`response:${body.ok}`); }, status() { return this; } };
  routes.get("POST /api/logout")[0](req, res);
  assert.deepEqual(calls, ["presence:session-1", "broadcast", "socket-revoked", "destroy", "audit:logout", "response:true"]);
});

test("logout reports durable session failure without a success audit", () => {
  const { routes, calls } = fixture();
  const req = { sessionID: "session-1", session: { operator: { username: "va" }, destroy(callback) { callback(new Error("fail")); } } };
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
  routes.get("POST /api/logout")[0](req, res);
  assert.equal(res.statusCode, 500);
  assert.equal(calls.includes("audit:logout"), false);
});

test("me publishes only the public projection after auth middleware", () => {
  const { routes } = fixture();
  const handlers = routes.get("GET /api/me");
  const req = { currentOperator: { username: "va", passwordHash: "private" } };
  const res = { json(body) { this.body = body; } };
  handlers[0](req, res, () => handlers[1](req, res));
  assert.deepEqual(res.body, { username: "va" });
});
