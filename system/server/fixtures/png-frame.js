// Dependency-free PNG encoder for test/fixture video frames. The fake WDA's MJPEG
// server needs real, decodable, DIFFERENT images on every frame (so a browser
// canvas visibly animates and byte-level assertions can tell frames apart) but
// this repository has no image library and Node has no JPEG encoder. PNG only
// needs zlib + a CRC, both in the standard library. The relay is format-agnostic
// (it keys on magic bytes), so PNG frames exercise exactly the same path as WDA's
// JPEG frames.

import zlib from "node:zlib";

function crc32(buffer) {
  if (typeof zlib.crc32 === "function") return zlib.crc32(buffer) >>> 0;
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

// pixel(x, y) -> [r, g, b] (0-255), or [r, g, b, a] when `alpha` is true.
export function pngFrame({ width, height, pixel, alpha = false }) {
  const channels = alpha ? 4 : 3;
  const rows = Buffer.alloc((width * channels + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const offset = y * (width * channels + 1);
    rows[offset] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a = 255] = pixel(x, y);
      const at = offset + 1 + x * channels;
      rows[at] = r; rows[at + 1] = g; rows[at + 2] = b;
      if (alpha) rows[at + 3] = a;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = alpha ? 6 : 2; // colour type: truecolour (+ alpha)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// A recognisable phone-ish test card that changes every frame: a dark gradient,
// a bright bar sweeping down (so motion is obvious) and the frame number encoded
// as coloured squares along the top (so a test can read it back if it wants to).
export function testCardFrame(index, { width = 90, height = 160 } = {}) {
  const bar = (index * 5) % height;
  return pngFrame({
    width,
    height,
    pixel: (x, y) => {
      if (y < 8) return [(index * 40) & 255, ((index >> 2) * 60) & 255, ((index >> 4) * 90) & 255];
      if (Math.abs(y - bar) < 3) return [255, 255, 255];
      return [20 + Math.floor((x / width) * 60), 30 + Math.floor((y / height) * 90), 90 + ((index * 3) & 63)];
    },
  });
}
