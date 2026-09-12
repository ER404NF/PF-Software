import { normalizeRole } from "./roleCapabilities.js";

const DEFAULT_STALE_AFTER_MS = 45_000;

function millis(value) {
  const result = value instanceof Date ? value.getTime() : Number(value);
  return Number.isFinite(result) ? result : null;
}

export function createPresenceStore({ now = () => Date.now(), staleAfterMs = DEFAULT_STALE_AFTER_MS } = {}) {
  const sessions = new Map();
  const connectionSessions = new Map();

  const currentTime = () => millis(now()) ?? Date.now();

  function touchSession({ sessionId, username, expiresAt }) {
    if (typeof sessionId !== "string" || !sessionId || typeof username !== "string" || !username) return false;
    const timestamp = currentTime();
    const expiry = millis(expiresAt);
    if (expiry !== null && expiry <= timestamp) {
      removeSession(sessionId);
      return false;
    }
    const existing = sessions.get(sessionId);
    if (existing && existing.username !== username) removeSession(sessionId);
    const record = sessions.get(sessionId) ?? {
      sessionId,
      username,
      firstSeenAt: timestamp,
      lastSeenAt: timestamp,
      expiresAt: expiry,
      connectedOnce: false,
      connections: new Map(),
    };
    record.lastSeenAt = timestamp;
    record.expiresAt = expiry;
    sessions.set(sessionId, record);
    return true;
  }

  function connect({ sessionId, connectionId, username, expiresAt }) {
    if (typeof connectionId !== "string" || !connectionId) return false;
    if (!touchSession({ sessionId, username, expiresAt })) return false;
    const previousSessionId = connectionSessions.get(connectionId);
    if (previousSessionId && previousSessionId !== sessionId) {
      sessions.get(previousSessionId)?.connections.delete(connectionId);
    }
    const timestamp = currentTime();
    sessions.get(sessionId).connectedOnce = true;
    sessions.get(sessionId).connections.set(connectionId, {
      connectedAt: timestamp,
      lastSeenAt: timestamp,
      deviceId: null,
    });
    connectionSessions.set(connectionId, sessionId);
    return true;
  }

  function heartbeat(connectionId) {
    const sessionId = connectionSessions.get(connectionId);
    const sessionRecord = sessions.get(sessionId);
    const connection = sessionRecord?.connections.get(connectionId);
    if (!connection) return false;
    const timestamp = currentTime();
    connection.lastSeenAt = timestamp;
    sessionRecord.lastSeenAt = timestamp;
    return true;
  }

  function setDevice(connectionId, deviceId) {
    const sessionId = connectionSessions.get(connectionId);
    const sessionRecord = sessions.get(sessionId);
    const connection = sessionRecord?.connections.get(connectionId);
    if (!connection) return false;
    connection.deviceId = typeof deviceId === "string" && deviceId ? deviceId : null;
    connection.lastSeenAt = currentTime();
    sessionRecord.lastSeenAt = connection.lastSeenAt;
    return true;
  }

  function disconnect(connectionId) {
    const sessionId = connectionSessions.get(connectionId);
    connectionSessions.delete(connectionId);
    const sessionRecord = sessions.get(sessionId);
    if (!sessionRecord) return false;
    const removed = sessionRecord.connections.delete(connectionId);
    sessionRecord.lastSeenAt = currentTime();
    return removed;
  }

  function removeSession(sessionId) {
    const sessionRecord = sessions.get(sessionId);
    if (!sessionRecord) return false;
    for (const connectionId of sessionRecord.connections.keys()) connectionSessions.delete(connectionId);
    sessions.delete(sessionId);
    return true;
  }

  function cleanup() {
    const timestamp = currentTime();
    const cutoff = timestamp - staleAfterMs;
    let changed = false;
    for (const [sessionId, sessionRecord] of sessions) {
      for (const [connectionId, connection] of sessionRecord.connections) {
        if (connection.lastSeenAt < cutoff) {
          sessionRecord.connections.delete(connectionId);
          connectionSessions.delete(connectionId);
          changed = true;
        }
      }
      const expired = sessionRecord.expiresAt !== null && sessionRecord.expiresAt <= timestamp;
      if (expired || (sessionRecord.connections.size === 0 && sessionRecord.lastSeenAt < cutoff)) {
        removeSession(sessionId);
        changed = true;
      }
    }
    return changed;
  }

  function listPeople(operators) {
    cleanup();
    const timestamp = currentTime();
    const cutoff = timestamp - staleAfterMs;
    const byUsername = new Map();
    for (const operator of operators) {
      if (!operator?.username) continue;
      byUsername.set(operator.username, {
        username: operator.username,
        role: normalizeRole(operator.role),
        online: false,
        lastSeenAt: null,
        activeSessions: 0,
        currentDeviceIds: [],
        activityCategory: null,
      });
    }

    for (const sessionRecord of sessions.values()) {
      const person = byUsername.get(sessionRecord.username);
      if (!person) continue;
      person.lastSeenAt = Math.max(person.lastSeenAt ?? 0, sessionRecord.lastSeenAt);
      const activeConnections = [...sessionRecord.connections.values()]
        .filter(connection => connection.lastSeenAt >= cutoff);
      // A session that never opened a WebSocket can still be live through
      // recent authenticated HTTP activity. Once it has used the live UI,
      // closing its final socket marks that browser session offline promptly.
      const sessionOnline = activeConnections.length > 0
        || (!sessionRecord.connectedOnce && sessionRecord.lastSeenAt >= cutoff);
      if (sessionOnline) {
        person.online = true;
        person.activeSessions += 1;
      }
      for (const connection of activeConnections) {
        if (connection.deviceId && !person.currentDeviceIds.includes(connection.deviceId)) {
          person.currentDeviceIds.push(connection.deviceId);
        }
      }
    }

    return [...byUsername.values()]
      .map(person => ({
        ...person,
        lastSeenAt: person.lastSeenAt === null ? null : new Date(person.lastSeenAt).toISOString(),
        currentDeviceIds: person.currentDeviceIds.sort(),
        activityCategory: person.currentDeviceIds.length ? "device-control" : person.online ? "available" : null,
      }))
      .sort((a, b) => Number(b.online) - Number(a.online) || a.username.localeCompare(b.username));
  }

  return {
    touchSession,
    connect,
    heartbeat,
    setDevice,
    disconnect,
    removeSession,
    cleanup,
    listPeople,
  };
}
