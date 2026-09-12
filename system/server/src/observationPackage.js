// Provider-independent device observation for MS8.2. The caller supplies a
// Device API adapter and task context; this module contains no model or
// platform reasoning. Accessibility data is preferred and a screenshot is
// captured only when structured data is absent or fails.

const DEFAULT_MAX_UI_TREE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_SCREENSHOT_BYTES = 20 * 1024 * 1024;
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);

function nonEmpty(value) {
  if (typeof value === "string") return value.trim().length > 0;
  return value !== null && typeof value === "object";
}

function safeError(error) {
  return error instanceof Error && error.message ? error.message.slice(0, 500) : "UI-tree capture failed";
}

export function validateImageFrame(frame, maxBytes = DEFAULT_MAX_SCREENSHOT_BYTES) {
  if (!frame || frame.kind !== "image" || !IMAGE_MIMES.has(frame.mime) || typeof frame.data !== "string") {
    throw new Error("screenshot fallback returned no supported image frame");
  }
  const compact = frame.data.replace(/\s/g, "");
  if (!compact || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)
    || Buffer.from(compact, "base64").toString("base64") !== compact) {
    throw new Error("screenshot fallback returned invalid base64 data");
  }
  const bytes = Buffer.byteLength(compact, "base64");
  if (!bytes || bytes > maxBytes) {
    throw new Error(`screenshot fallback size must be between 1 and ${maxBytes} bytes`);
  }
  return { kind: "image", mime: frame.mime, data: compact };
}

export async function captureObservation(device, {
  goal,
  platform = null,
  accountId = null,
  taskId = null,
  now = () => new Date(),
  canObserve = () => true,
  maxUiTreeBytes = DEFAULT_MAX_UI_TREE_BYTES,
  maxScreenshotBytes = DEFAULT_MAX_SCREENSHOT_BYTES,
} = {}) {
  if (!device || typeof device.id !== "string") throw new Error("observation requires a device with an id");
  if (typeof goal !== "string" || !goal.trim()) throw new Error("observation requires a non-empty goal");

  const capturedAt = now().toISOString();
  const base = {
    goal: goal.trim(),
    platform,
    device_id: device.id,
    platform_account_id: accountId,
    task_id: taskId,
    captured_at: capturedAt,
    source: null,
    ui_tree: null,
    ui_tree_error: null,
    screenshot_ref: null,
    screenshot: null,
  };

  if (!canObserve()) throw new Error("Observation authorization was revoked");
  if (typeof device.getUiTree === "function") {
    try {
      const tree = await device.getUiTree();
      if (nonEmpty(tree)) {
        const bytes = Buffer.byteLength(typeof tree === "string" ? tree : JSON.stringify(tree));
        if (bytes <= maxUiTreeBytes) return { ...base, source: "ui_tree", ui_tree: tree };
        base.ui_tree_error = `UI tree exceeded ${maxUiTreeBytes} bytes`;
      } else {
        base.ui_tree_error = "UI tree was empty";
      }
    } catch (error) {
      base.ui_tree_error = safeError(error);
    }
  } else {
    base.ui_tree_error = "device adapter does not expose a UI tree";
  }

  if (!canObserve()) throw new Error("Observation authorization was revoked");
  if (typeof device.render !== "function") throw new Error(`${base.ui_tree_error}; screenshot fallback is unavailable`);
  const screenshot = validateImageFrame(await device.render(), maxScreenshotBytes);
  return {
    ...base,
    source: "screenshot",
    screenshot_ref: `observation:${device.id}:${capturedAt}`,
    screenshot,
  };
}

export function observationForText(observation) {
  if (!observation || typeof observation !== "object") return observation;
  const { screenshot, ...metadata } = observation;
  return metadata;
}

export { DEFAULT_MAX_UI_TREE_BYTES, DEFAULT_MAX_SCREENSHOT_BYTES };
