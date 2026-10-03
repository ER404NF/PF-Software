import test from "node:test";
import assert from "node:assert/strict";
import {
  publicSiteRpcError,
  sanitizeAdvertisedDevices,
  sanitizeSiteStreamState,
  siteRpcErrorFromPayload,
} from "../../src/siteProtocol.js";

test("site RPC exceptions cross the agent link as a bounded code and public message", () => {
  const payload = publicSiteRpcError(new Error("PRIVATE_WDA_RESPONSE at /Users/operator/device.log"));
  assert.deepEqual(payload, {
    code: "SITE_ACTION_FAILED",
    message: "The site could not perform the action.",
  });
  assert.doesNotMatch(JSON.stringify(payload), /PRIVATE_WDA_RESPONSE|Users|device\.log/);
});

test("the hub ignores untrusted remote RPC messages and malformed codes", () => {
  const error = siteRpcErrorFromPayload({
    code: "bad-code\nINJECTED",
    message: "PRIVATE_REMOTE_MESSAGE",
  });
  assert.equal(error.code, "SITE_ACTION_FAILED");
  assert.equal(error.message, "The site could not perform the action.");
  assert.doesNotMatch(JSON.stringify({ code: error.code, message: error.message }), /PRIVATE_REMOTE_MESSAGE|INJECTED/);
});

test("remote discovery status uses hub-authored guidance, never agent-authored detail", () => {
  const [device] = sanitizeAdvertisedDevices([{
    id: "phone-1",
    label: "Phone 1",
    type: "wda",
    ready: false,
    supportsStream: true,
    discoveryState: "provisioning_error",
    discoveryStateMessage: "PRIVATE_SIGNING_PATH /Users/operator/WebDriverAgent",
  }]);
  assert.equal(device.discoveryStateMessage, "Automatic device setup failed at this site. Review that host's local diagnostics.");
  assert.doesNotMatch(JSON.stringify(device), /PRIVATE_SIGNING_PATH|Users|WebDriverAgent/);
});

test("remote stream state never forwards agent-authored detail or unknown states", () => {
  assert.deepEqual(sanitizeSiteStreamState({
    state: "reconnecting",
    detail: "PRIVATE_SOCKET_ERROR at wss://token@example.test",
  }), {
    state: "reconnecting",
    detail: "Remote video is reconnecting.",
  });
  assert.deepEqual(sanitizeSiteStreamState({
    state: "INJECTED_STATE",
    detail: "PRIVATE_REMOTE_MESSAGE",
  }), {
    state: "reconnecting",
    detail: "Remote video is reconnecting.",
  });
  assert.deepEqual(sanitizeSiteStreamState({ state: "live", detail: "PRIVATE" }), {
    state: "live",
    detail: null,
  });
});
