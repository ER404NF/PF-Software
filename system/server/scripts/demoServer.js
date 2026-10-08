// Demo only: the same server as `src/index.js`, plus two phones in the states seen in the screen recording.
// Started by `npm run demo -- --broken-phones`; never packaged and refuses to run anywhere that is not the throwaway demo.

import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertDemoEnvironment } from "./demoOptions.js";
import { installBrokenPhones, startEnrollmentOnB } from "./demoBrokenPhones.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(here, "../src/index.js");

assertDemoEnvironment(process.env, os.tmpdir());

// The real server only starts listening when it is the program that was run. Point the program name at it, then load it.
process.argv[1] = entry;
const server = await import(pathToFileURL(entry).href);
const { devices, broadcastDeviceList, setDeviceProvisionerForTests, setNetworkRoutingForTests } = server;

const demo = await installBrokenPhones({
  devices,
  onDeviceListChanged: broadcastDeviceList,
  storeDir: path.join(path.dirname(process.env.OPERATORS_CONFIG_PATH), "phones"),
  pausedSetup: process.env.DEMO_PAUSED_SETUP === "1",
});

// The test-only doors are opened for this one synchronous moment (no awaits) and closed again.
const before = process.env.NODE_ENV;
process.env.NODE_ENV = "test";
try {
  setDeviceProvisionerForTests(demo.provisioner);
  setNetworkRoutingForTests({
    orchestrator: { bridgeIface: "bridge100", getRoute: () => null },
    setupState: { state: "enabled", message: "Proxy routing is enabled and the Internet Sharing bridge is configured." },
    listBridgeMembers: async () => ["en5"],
  });
} finally {
  if (before === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = before;
}

// Wait until the server is listening, then start the enrollment on phone B through the real route.
for (let attempt = 0; attempt < 100 && !server.server.listening; attempt += 1) await new Promise(resolve => setTimeout(resolve, 100));
if (server.server.listening) {
  try {
    await startEnrollmentOnB({
      baseUrl: `http://127.0.0.1:${server.server.address().port}`,
      username: process.env.DEMO_ADMIN_USER, password: process.env.DEMO_ADMIN_PASSWORD, deviceId: demo.ids.b,
    });
    console.log("[demo] broken-phones mode: phone A has its port blocked, phone B has control stopped and a network enrollment pending.");
  } catch (error) {
    console.error(`[demo] ${error.message}`);
  }
}
