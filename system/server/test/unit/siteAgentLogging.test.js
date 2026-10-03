import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { SiteAgent } from "../../src/siteAgent.js";

class FakeWebSocket extends EventEmitter {
  static instance = null;

  constructor() {
    super();
    this.readyState = 0;
    FakeWebSocket.instance = this;
  }

  close() {}
}

test("site-agent operational logs never include transport or handler exception text", async () => {
  const logs = [];
  const agent = new SiteAgent({
    hubUrl: "https://phones.example.com/setup?private=value",
    siteId: "rome",
    token: "pfs_test",
    devices: new Map(),
    WebSocketImpl: FakeWebSocket,
    log: line => logs.push(line),
  });
  agent.stopped = false;
  agent._connect();

  const socketError = Object.assign(new Error("PRIVATE_HOST_AND_PATH /Users/operator/hub"), { code: "ECONNREFUSED" });
  FakeWebSocket.instance.emit("error", socketError);
  agent._onMessage = async () => { throw new Error("PRIVATE_REMOTE_RESPONSE"); };
  FakeWebSocket.instance.emit("message", Buffer.from("{}"), false);
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(logs, ["link error: ECONNREFUSED", "message failed: Error"]);
  assert.doesNotMatch(logs.join("\n"), /PRIVATE|Users|operator/);
  assert.equal(agent.url, "wss://phones.example.com/agent-link");
  agent.stop();
});

test("site-agent URLs reject embedded credentials before a socket is created", () => {
  assert.throws(() => new SiteAgent({
    hubUrl: "https://user:secret@phones.example.com",
    siteId: "rome",
    token: "pfs_test",
    devices: new Map(),
    WebSocketImpl: FakeWebSocket,
  }), /without embedded credentials/);
});
