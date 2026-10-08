import { test } from "node:test";
import assert from "node:assert/strict";
import { startEnrollmentOnB } from "../../scripts/demoBrokenPhones.js";

// Found by the full suite: the demo's own sign-in sometimes got "401" on the very next request. The server (like any
// express-session server) sends the headers and nearly all of the body BEFORE the session file is saved; only the last
// byte waits. A caller that uses the cookie as soon as the headers arrive can be one step ahead of the saved session.
// Reading the whole login answer first is the project's own convention (see scripts/soak-test.js).
function fakeFetch(events, { loginBodyDelayMs = 20 } = {}) {
  let bodyRead = false;
  return async (url, options = {}) => {
    if (String(url).endsWith("/api/login")) {
      events.push("login-headers");
      return {
        ok: true, status: 200,
        headers: { getSetCookie: () => ["sid=abc; Path=/; HttpOnly"], get: () => "sid=abc; Path=/" },
        async json() { await new Promise(resolve => setTimeout(resolve, loginBodyDelayMs)); bodyRead = true; events.push("login-body-read"); return {}; },
        async text() { await this.json(); return ""; },
      };
    }
    events.push(bodyRead ? "start-after-body" : "start-BEFORE-body");
    assert.equal(options.headers.Cookie, "sid=abc");
    return { ok: true, status: 200, async json() { return { enrollment: { state: "pending" } }; } };
  };
}

test("the enrollment is started only after the whole sign-in answer has been read", async () => {
  const events = [];
  const result = await startEnrollmentOnB({
    baseUrl: "http://demo.test", username: "u", password: "p", deviceId: "dev", fetchImpl: fakeFetch(events), pauseMs: 1,
  });
  assert.equal(result.enrollment.state, "pending");
  assert.deepEqual(events, ["login-headers", "login-body-read", "start-after-body"]);
});
