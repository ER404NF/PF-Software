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
const APP_SCREEN_LABELS = {
  instagram: "Instagram home",
  reddit: "Reddit home",
  x: "Home timeline",
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
    this.kind = "mock";
    this.status = "idle"; // idle | in-use | offline
    this.screen = "home"; // home | app
    this.openApp = null;
    this.typedText = "";
    this.lastSwipe = null;
    this.scrollY = 0; // px the app feed has been dragged up; makes scrolling visible in the live view
    this.lastGesture = null;
    this.streams = new Set();
  }

  // ---- live view ------------------------------------------------------------
  // The mock "streams" by pushing a fresh SVG whenever its state changes (plus a
  // slow heartbeat), so the browser exercises the same live-video path it uses
  // for a real phone.
  get supportsStream() {
    return true;
  }

  openStream({ onFrame, onState = () => {} } = {}) {
    const listener = () => onFrame(Buffer.from(this.renderSvg()));
    this.streams.add(listener);
    onState("connecting");
    listener();
    onState("live");
    const beat = setInterval(listener, 1000);
    beat.unref?.();
    return {
      close: () => {
        clearInterval(beat);
        this.streams.delete(listener);
        onState("closed");
      },
    };
  }

  _changed() {
    for (const listener of this.streams) listener();
  }

  tap(xNorm, yNorm) {
    this._tap(xNorm, yNorm);
    this._changed();
  }

  _tap(xNorm, yNorm) {
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
        this.scrollY = 0;
      }
    }
  }

  // No meaningful "swipe target" to simulate — just record it so it's
  // visible on screen, enough to confirm the action round-tripped correctly.
  swipe(direction) {
    this.lastSwipe = direction;
    this._changed();
  }

  // Finger-drag, normalised 0..1 like the real WDA path. Dragging up scrolls the
  // feed down, exactly like a phone.
  drag(x1, y1, x2, y2) {
    const dx = (x2 - x1) * WIDTH;
    const dy = (y2 - y1) * HEIGHT;
    this.lastSwipe = Math.abs(dy) >= Math.abs(dx) ? (dy < 0 ? "up" : "down") : (dx < 0 ? "left" : "right");
    if (this.screen === "app") this.scrollY = Math.max(0, Math.min(FEED_ROWS * FEED_ROW_HEIGHT, this.scrollY - dy));
    this.lastGesture = "drag";
    this._changed();
  }

  longPress() {
    this.lastGesture = "long-press";
    this._changed();
  }

  doubleTap(xNorm, yNorm) {
    this._tap(xNorm, yNorm);
    this.lastGesture = "double-tap";
    this._changed();
  }

  // Backspace and return arrive as the characters WDA's keys endpoint takes.
  typeText(text) {
    for (const char of String(text)) {
      if (char === "\b") this.typedText = this.typedText.slice(0, -1);
      else this.typedText += char;
    }
    this._changed();
  }

  // Mirrors the real hardware Home button (WdaDevice.pressHome) — always
  // succeeds and always returns to the springboard, regardless of what was
  // open, matching real iOS behavior (Home backgrounds the current app
  // unconditionally, unlike the in-app Back button which only works from
  // specific screens).
  pressHome() {
    this.screen = "home";
    this.openApp = null;
    this.scrollY = 0;
    this._changed();
  }

  renderSvg() {
    return this.screen === "home" ? renderHome() : renderApp(this.openApp, this.typedText, this.lastSwipe, this.scrollY);
  }

  async render() {
    return { kind: "svg", data: this.renderSvg() };
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
      { type: "staticText", id: "screen-title", label: APP_SCREEN_LABELS[this.openApp] ?? "App home" },
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

const FEED_ROWS = 40;
const FEED_ROW_HEIGHT = 72;

function renderApp(appId, typedText = "", lastSwipe = null, scrollY = 0) {
  const app = APPS[appId] || { label: "App", color: "#333" };
  const swipeLine = lastSwipe
    ? `<text x="${WIDTH / 2}" y="${HEIGHT / 2 + 30}" font-size="13" fill="rgba(255,255,255,0.7)" text-anchor="middle">last swipe: ${escapeXml(lastSwipe)}</text>`
    : "";
  const typedLine = typedText
    ? `<text x="${WIDTH / 2}" y="${HEIGHT / 2 + 50}" font-size="13" fill="rgba(255,255,255,0.7)" text-anchor="middle">typed: ${escapeXml(typedText)}</text>`
    : "";
  return svgFrame(`
    <rect width="${WIDTH}" height="${HEIGHT}" fill="${app.color}" />
    ${renderFeed(scrollY)}
    <rect x="${BACK_BUTTON.x}" y="${BACK_BUTTON.y}" width="${BACK_BUTTON.w}" height="${BACK_BUTTON.h}" rx="8" fill="rgba(255,255,255,0.2)" />
    <text x="${BACK_BUTTON.x + BACK_BUTTON.w / 2}" y="${BACK_BUTTON.y + 26}" font-size="14" fill="#fff" text-anchor="middle">&#8592; Back</text>
    <text x="${WIDTH / 2}" y="${HEIGHT / 2}" font-size="20" fill="#fff" text-anchor="middle">${app.label} (mock)</text>
    ${swipeLine}
    ${typedLine}
  `);
}

function renderFeed(scrollY) {
  const rows = [];
  for (let index = 0; index < FEED_ROWS; index += 1) {
    const top = 70 + index * FEED_ROW_HEIGHT - scrollY;
    if (top < -FEED_ROW_HEIGHT || top > HEIGHT) continue;
    rows.push(`<rect x="16" y="${top}" width="${WIDTH - 32}" height="${FEED_ROW_HEIGHT - 10}" rx="10" fill="rgba(255,255,255,0.14)" />
      <text x="30" y="${top + 30}" font-size="14" fill="#fff">Post ${index + 1}</text>`);
  }
  return rows.join("");
}

function svgFrame(inner) {
  return `<svg viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;
}

// typedText/lastSwipe are embedded into SVG that the client renders via
// innerHTML — unescaped input could break the markup or inject content.
function escapeXml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
  }[c]));
}
