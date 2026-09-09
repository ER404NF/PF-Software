// Stand-in for a real phone until hardware arrives. Same tap-in / screen-out
// shape as the eventual WDA client (see server/src/index.js and README) so
// swapping this for a real device later doesn't change the protocol.

const WIDTH = 375;
const HEIGHT = 667; // iPhone SE logical point size

const APPS = {
  instagram: { label: "Instagram", color: "#d6249f" },
  camera: { label: "Camera", color: "#3a3a3c" },
  settings: { label: "Settings", color: "#8e8e93" },
};

const HOME_ICONS = [
  { id: "instagram", cx: 70, cy: 120 },
  { id: "camera", cx: 187, cy: 120 },
  { id: "settings", cx: 304, cy: 120 },
];

const ICON_RADIUS = 32;
const BACK_BUTTON = { x: 10, y: 10, w: 70, h: 40 };

export class MockDevice {
  constructor(id, label) {
    this.id = id;
    this.label = label;
    this.status = "idle"; // idle | in-use | offline
    this.screen = "home"; // home | app
    this.openApp = null;
    this.typedText = "";
    this.lastSwipe = null;
  }

  tap(xNorm, yNorm) {
    const x = xNorm * WIDTH;
    const y = yNorm * HEIGHT;

    if (this.screen === "home") {
      const hit = HOME_ICONS.find((icon) => Math.hypot(icon.cx - x, icon.cy - y) <= ICON_RADIUS);
      if (hit) {
        this.screen = "app";
        this.openApp = hit.id;
      }
      return;
    }

    if (this.screen === "app") {
      const b = BACK_BUTTON;
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
        this.screen = "home";
        this.openApp = null;
      }
    }
  }

  // No meaningful "swipe target" to simulate — just record it so it's
  // visible on screen, enough to confirm the action round-tripped correctly.
  swipe(direction) {
    this.lastSwipe = direction;
  }

  typeText(text) {
    this.typedText += text;
  }

  // Mirrors the real hardware Home button (WdaDevice.pressHome) — always
  // succeeds and always returns to the springboard, regardless of what was
  // open, matching real iOS behavior (Home backgrounds the current app
  // unconditionally, unlike the in-app Back button which only works from
  // specific screens).
  pressHome() {
    this.screen = "home";
    this.openApp = null;
  }

  async render() {
    const svg = this.screen === "home" ? renderHome() : renderApp(this.openApp, this.typedText, this.lastSwipe);
    return { kind: "svg", data: svg };
  }

  async getUiTree() {
    if (this.screen === "home") {
      return { format: "mock-json", screen: "home", viewport: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
        elements: HOME_ICONS.map((icon) => ({
        type: "button", id: icon.id, label: APPS[icon.id].label,
        frame: { x: icon.cx - ICON_RADIUS, y: icon.cy - ICON_RADIUS, width: ICON_RADIUS * 2, height: ICON_RADIUS * 2 },
      })) };
    }
    return { format: "mock-json", screen: "app", app: this.openApp,
      viewport: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
      lastSwipe: this.lastSwipe, elements: [
      { type: "button", id: "back", label: "Back", frame: { ...BACK_BUTTON } },
    ] };
  }
}

function renderHome() {
  const icons = HOME_ICONS.map((icon) => {
    const app = APPS[icon.id];
    return `
      <circle cx="${icon.cx}" cy="${icon.cy}" r="${ICON_RADIUS}" fill="${app.color}" />
      <text x="${icon.cx}" y="${icon.cy + ICON_RADIUS + 18}" font-size="13" fill="#1c1c1e" text-anchor="middle">${app.label}</text>
    `;
  }).join("");

  return svgFrame(`
    <rect width="${WIDTH}" height="${HEIGHT}" fill="#f2f2f7" />
    <text x="${WIDTH / 2}" y="60" font-size="15" fill="#8e8e93" text-anchor="middle">Home</text>
    ${icons}
  `);
}

function renderApp(appId, typedText = "", lastSwipe = null) {
  const app = APPS[appId] || { label: "App", color: "#333" };
  const swipeLine = lastSwipe
    ? `<text x="${WIDTH / 2}" y="${HEIGHT / 2 + 30}" font-size="13" fill="rgba(255,255,255,0.7)" text-anchor="middle">last swipe: ${escapeXml(lastSwipe)}</text>`
    : "";
  const typedLine = typedText
    ? `<text x="${WIDTH / 2}" y="${HEIGHT / 2 + 50}" font-size="13" fill="rgba(255,255,255,0.7)" text-anchor="middle">typed: ${escapeXml(typedText)}</text>`
    : "";
  return svgFrame(`
    <rect width="${WIDTH}" height="${HEIGHT}" fill="${app.color}" />
    <rect x="${BACK_BUTTON.x}" y="${BACK_BUTTON.y}" width="${BACK_BUTTON.w}" height="${BACK_BUTTON.h}" rx="8" fill="rgba(255,255,255,0.2)" />
    <text x="${BACK_BUTTON.x + BACK_BUTTON.w / 2}" y="${BACK_BUTTON.y + 26}" font-size="14" fill="#fff" text-anchor="middle">&larr; Back</text>
    <text x="${WIDTH / 2}" y="${HEIGHT / 2}" font-size="20" fill="#fff" text-anchor="middle">${app.label} (mock)</text>
    ${swipeLine}
    ${typedLine}
  `);
}

function svgFrame(inner) {
  return `<svg viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;
}

// typedText/lastSwipe are embedded into SVG that the client renders via
// innerHTML — unescaped input could break the markup or inject content.
function escapeXml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
  }[c]));
}
