import test from "node:test";
import assert from "node:assert/strict";
import { assertAuditEventRepository } from "../../src/persistence/auditEventRepository.js";
import { createAuditService } from "../../src/services/auditService.js";

function fixtureRepository(events = []) {
  const calls = [];
  return {
    calls,
    logEvent(event) {
      calls.push({ method: "logEvent", event });
      return event;
    },
    listEvents(filters) {
      calls.push({ method: "listEvents", filters });
      return events;
    },
  };
}

test("audit repository contract rejects incomplete adapters", () => {
  assert.throws(() => assertAuditEventRepository(null), /must be an object/);
  assert.throws(() => assertAuditEventRepository({ logEvent() {} }), /requires listEvents/);
  assert.throws(() => assertAuditEventRepository({ listEvents() {} }), /requires logEvent/);
});

test("audit service preserves the established write and raw-query surface", () => {
  const repository = fixtureRepository([{ type: "existing" }]);
  const service = createAuditService({ repository, canAccessDevice: () => false });
  const event = { type: "created" };

  assert.equal(service.logEvent(event), event);
  assert.deepEqual(service.listEvents({ limit: 2 }), [{ type: "existing" }]);
  assert.deepEqual(repository.calls, [
    { method: "logEvent", event },
    { method: "listEvents", filters: { limit: 2 } },
  ]);
});

test("authorized audit reads keep global events and only accessible device events", () => {
  const repository = fixtureRepository([
    { id: "global", deviceId: null },
    { id: "allowed", deviceId: "phone-a" },
    { id: "denied", deviceId: "phone-b" },
  ]);
  const viewer = { username: "manager" };
  const service = createAuditService({
    repository,
    canAccessDevice: (operator, deviceId) => operator === viewer && deviceId === "phone-a",
  });

  assert.deepEqual(
    service.listAuthorizedEvents(viewer, { operator: "va-1", deviceId: "phone-a", limit: 10 }),
    [{ id: "global", deviceId: null }, { id: "allowed", deviceId: "phone-a" }],
  );
  assert.deepEqual(repository.calls[0], {
    method: "listEvents",
    filters: { operator: "va-1", deviceId: "phone-a", limit: 1000 },
  });
});

test("authorized audit reads retain the existing default and maximum bounds", () => {
  const events = Array.from({ length: 1100 }, (_, index) => ({ id: index, deviceId: null }));
  const service = createAuditService({ repository: fixtureRepository(events), canAccessDevice: () => true });

  assert.equal(service.listAuthorizedEvents({}).length, 200);
  assert.equal(service.listAuthorizedEvents({}, { limit: 5000 }).length, 1000);
});

test("audit service fails at composition time when authorization is missing", () => {
  assert.throws(
    () => createAuditService({ repository: fixtureRepository() }),
    /requires canAccessDevice/,
  );
});
