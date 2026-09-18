import fs from "fs";

export function loadDeviceConfig({
  env = process.env,
  defaultPath,
  existsSync = fs.existsSync,
  readFileSync = fs.readFileSync,
} = {}) {
  const explicitPath = env.DEVICE_CONFIG_PATH;
  const useDefault = env.DESKTOP_AUTO_DEVICE_MODE !== "true";
  const selectedPath = explicitPath || (useDefault ? defaultPath : null);
  if (!selectedPath || !existsSync(selectedPath)) return { devices: [] };
  return JSON.parse(readFileSync(selectedPath, "utf8"));
}
