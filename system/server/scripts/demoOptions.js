// Options and safety checks for the demo's optional "broken phones" mode. This file, and the others used only by the
// demo, live in scripts/ and are never packaged: the installer copies only server/src.

// A port range for the demo's pretend phones that cannot overlap what real phones use (WDA 8100-8199, video 9100-9199),
// so nothing the demo probes can ever be another program on a shared Mac.
export const DEMO_CONTROL_PORT_RANGE = Object.freeze({ start: 38100, end: 38109 });
export const DEMO_VIDEO_PORT_RANGE = Object.freeze({ start: 38200, end: 38209 });

// Off unless someone asks for it with the flag or the variable.
export function brokenPhonesRequested(argv = process.argv, env = process.env) {
  return argv.includes("--broken-phones") || env.DEMO_BROKEN_PHONES === "1";
}

// Off unless someone asks for it. Shows the Fleet page with automatic phone setup paused on a damaged record, so the notice
// and its Check again button can be tried. It needs the two demo phones, so asking for it also turns those on.
export function pausedSetupRequested(argv = process.argv, env = process.env) {
  return argv.includes("--paused-setup") || env.DEMO_PAUSED_SETUP === "1";
}

// The environment the demo's server child gets in this mode: every switch that could reach a real phone, a real
// network setting or real discovery is forced off, whatever the caller's shell had set.
export function brokenPhonesEnvironment() {
  return {
    DEMO_BROKEN_PHONES: "1",
    AUTO_DISCOVER_IOS_DEVICES: "false",
    AUTO_PROVISION_WDA: "false",
    AUTO_ROUTE_PROXY_TUNNELS: "false",
    AUTO_NETWORK_ENROLLMENT: "false",
    AUTO_ENABLE_INTERNET_SHARING: "false",
    WDA_PORT_RANGE_START: String(DEMO_CONTROL_PORT_RANGE.start),
    WDA_PORT_RANGE_END: String(DEMO_CONTROL_PORT_RANGE.end),
    WDA_MJPEG_PORT_RANGE_START: String(DEMO_VIDEO_PORT_RANGE.start),
    WDA_MJPEG_PORT_RANGE_END: String(DEMO_VIDEO_PORT_RANGE.end),
  };
}

// Refuses to run anywhere that is not clearly the throwaway demo.
export function assertDemoEnvironment(env = process.env, tmpRoot) {
  if (env.NODE_ENV === "production") throw new Error("The broken-phones demo never runs in production.");
  if (env.PHONE_FARM_LOCAL_DEV !== "true") throw new Error("The broken-phones demo only runs with PHONE_FARM_LOCAL_DEV=true.");
  const demoFolder = String(env.OPERATORS_CONFIG_PATH ?? "");
  const root = String(tmpRoot ?? "").replaceAll("\\", "/").toLowerCase();
  const inTemp = value => String(value ?? "").replaceAll("\\", "/").toLowerCase().startsWith(root) && /phonefarm-demo-/.test(String(value));
  for (const key of ["OPERATORS_CONFIG_PATH", "SESSION_STORE_DIR", "AUDIT_LOG_PATH", "QUEUE_STORE_PATH", "DEVICE_CONFIG_PATH"]) {
    if (!inTemp(env[key])) throw new Error(`The broken-phones demo keeps everything in its own temporary folder; ${key} is somewhere else.`);
  }
  return demoFolder;
}
