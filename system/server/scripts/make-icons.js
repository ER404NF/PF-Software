// Generates the Phone Farm app icons (web app, favicon, desktop app) with no image
// library: a phone with a live-video dot and a home button on a dark tile.
//
//   node server/scripts/make-icons.js
//
// Writes system/client/icons/* and desktop/build/icon.png. The output is committed;
// re-run this only to change the design.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pngFrame } from "../fixtures/png-frame.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const systemRoot = path.resolve(here, "../..");
const clientIcons = path.join(systemRoot, "client/icons");
const desktopBuild = path.resolve(systemRoot, "../desktop/build");

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const mix = (a, b, t) => a.map((channel, index) => Math.round(channel + (b[index] - channel) * t));

// Signed distance to a rounded rectangle (negative inside).
function roundRect(px, py, cx, cy, halfWidth, halfHeight, radius) {
  const qx = Math.abs(px - cx) - (halfWidth - radius);
  const qy = Math.abs(py - cy) - (halfHeight - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

// Colour of the design at (u, v) in the unit square. `scale` shrinks the artwork
// towards the centre (for the maskable icon's safe zone); `tile` is the tile's
// corner radius, or 0 for a full-bleed square.
function artwork(u, v, { scale, tile }) {
  const ax = 0.5 + (u - 0.5) / scale;
  const ay = 0.5 + (v - 0.5) / scale;
  const background = mix([0x2f, 0x34, 0x3c], [0x0e, 0x10, 0x13], clamp((u + v) / 2, 0, 1));
  let colour = background;
  let alpha = 255;
  if (tile > 0) {
    const edge = roundRect(u, v, 0.5, 0.5, 0.5, 0.5, tile);
    alpha = Math.round(255 * clamp(0.5 - edge * 512, 0, 1)); // ~1px soft edge at 512px
  }
  const body = roundRect(ax, ay, 0.5, 0.5, 0.2, 0.34, 0.075);
  if (body < 0) {
    colour = [0xf1, 0xf3, 0xf5]; // the phone's frame
    if (body < -0.03) {
      colour = mix([0x24, 0x29, 0x31], [0x12, 0x15, 0x1a], clamp((ay - 0.2) / 0.5, 0, 1)); // its screen
      if (Math.hypot(ax - 0.62, ay - 0.27) < 0.034) colour = [0x00, 0xd0, 0x5a]; // "live" dot
      if (roundRect(ax, ay, 0.5, 0.42, 0.11, 0.008, 0.008) < 0) colour = [0x5b, 0x63, 0x6e]; // status line
      if (roundRect(ax, ay, 0.5, 0.5, 0.11, 0.008, 0.008) < 0) colour = [0x3b, 0x42, 0x4b];
      if (roundRect(ax, ay, 0.5, 0.58, 0.11, 0.008, 0.008) < 0) colour = [0x3b, 0x42, 0x4b];
    }
    // The home button, drawn as a ring on the frame.
    const home = Math.hypot(ax - 0.5, ay - 0.795);
    if (home < 0.034 && home > 0.024) colour = [0x2b, 0x30, 0x38];
  }
  return [...colour, alpha];
}

function render(size, options) {
  const samples = size >= 512 ? 2 : 3; // supersampling keeps small icons smooth
  return pngFrame({
    width: size,
    height: size,
    alpha: true,
    pixel: (x, y) => {
      const sum = [0, 0, 0, 0];
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const [r, g, b, a] = artwork((x + (sx + 0.5) / samples) / size, (y + (sy + 0.5) / samples) / size, options);
          sum[0] += r * a; sum[1] += g * a; sum[2] += b * a; sum[3] += a;
        }
      }
      const total = sum[3] || 1;
      return [Math.round(sum[0] / total), Math.round(sum[1] / total), Math.round(sum[2] / total), Math.round(sum[3] / (samples * samples))];
    },
  });
}

const outputs = [
  [path.join(clientIcons, "icon-192.png"), render(192, { scale: 1, tile: 0.2 })],
  [path.join(clientIcons, "icon-512.png"), render(512, { scale: 1, tile: 0.2 })],
  // Android crops maskable icons to a circle/squircle: full bleed, artwork inside the safe zone.
  [path.join(clientIcons, "icon-maskable-512.png"), render(512, { scale: 0.74, tile: 0 })],
  // iOS applies its own rounding and dislikes transparency.
  [path.join(clientIcons, "apple-touch-icon.png"), render(180, { scale: 0.86, tile: 0 })],
  [path.join(desktopBuild, "icon.png"), render(1024, { scale: 1, tile: 0.2 })],
];
for (const [file, data] of outputs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  console.log(`wrote ${path.relative(path.resolve(systemRoot, ".."), file)} (${data.length} bytes)`);
}

fs.writeFileSync(path.join(clientIcons, "icon.svg"), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2f343c"/><stop offset="1" stop-color="#0e1013"/></linearGradient></defs>
  <rect width="512" height="512" rx="102" fill="url(#bg)"/>
  <rect x="154" y="88" width="204" height="348" rx="38" fill="#f1f3f5"/>
  <rect x="169" y="103" width="174" height="318" rx="24" fill="#1b1f26"/>
  <circle cx="318" cy="138" r="17" fill="#00d05a"/>
  <rect x="199" y="212" width="114" height="8" rx="4" fill="#5b636e"/>
  <rect x="199" y="256" width="114" height="8" rx="4" fill="#3b424b"/>
  <rect x="199" y="298" width="114" height="8" rx="4" fill="#3b424b"/>
  <circle cx="256" cy="407" r="14" fill="none" stroke="#2b3038" stroke-width="5"/>
</svg>
`);
console.log("wrote system/client/icons/icon.svg");
