import {
  loadProxyRecords, getProxyRecord, createProxy, deleteProxy,
  assignProxyToDevice, proxyForDevice, updateProxyHealth, publicProxies,
} from "../proxyPool.js";
import { assertProxyPoolRepository } from "./proxyPoolRepository.js";

// Adapts the existing storePath-parameterized proxyPool.js functions to the
// proxy pool repository port, binding storePath once instead of threading it
// through every call site. No storage format or behavior changes.
export function createFileProxyPoolRepository(storePath) {
  if (typeof storePath !== "string" || !storePath) {
    throw new TypeError("file proxy pool repository requires a storePath");
  }

  return assertProxyPoolRepository({
    load() { return loadProxyRecords(storePath); },
    get(proxyId) { return getProxyRecord(storePath, proxyId); },
    create(fields, masterKey) { return createProxy(storePath, fields, masterKey); },
    remove(proxyId) { return deleteProxy(storePath, proxyId); },
    assignToDevice(input) { return assignProxyToDevice(storePath, input); },
    forDevice(deviceId) { return proxyForDevice(storePath, deviceId); },
    updateHealth(proxyId, health) { return updateProxyHealth(storePath, proxyId, health); },
    publicList() { return publicProxies(storePath); },
  });
}
