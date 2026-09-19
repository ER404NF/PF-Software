// Splits a multipart/x-mixed-replace (MJPEG) byte stream into individual image
// frames. WebDriverAgent's MJPEG server (default device port 9100) sends
//
//   --BoundaryString\r\nContent-type: image/jpeg\r\nContent-Length: 12345\r\n\r\n<12345 bytes>\r\n
//
// once per frame. Content-Length is trusted when present and sane; without it the
// parser falls back to scanning for the JPEG start/end markers. Chunk boundaries
// from the network fall anywhere, including inside headers, so state is kept
// between push() calls. Never throws on garbage: it resynchronises instead, so a
// corrupt patch of the stream costs frames, not the connection.

const HEADER_END = Buffer.from("\r\n\r\n");
const MAX_HEADER_BYTES = 4096;
const JPEG_SOI = Buffer.from([0xff, 0xd8]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);

// 1 = JPEG, 2 = PNG, 3 = SVG (the mock phone), 0 = something else. Used as the
// one-byte header on binary WebSocket frames so the browser knows what it is
// decoding.
export function frameKind(frame) {
  if (frame?.length >= 3 && frame[0] === 0xff && frame[1] === 0xd8 && frame[2] === 0xff) return 1;
  if (frame?.length >= 4 && frame[0] === 0x89 && frame[1] === 0x50 && frame[2] === 0x4e && frame[3] === 0x47) return 2;
  if (frame?.length >= 4 && frame[0] === 0x3c && frame[1] === 0x73 && frame[2] === 0x76 && frame[3] === 0x67) return 3; // "<svg"
  return 0;
}

export class MjpegParser {
  constructor({ maxFrameBytes = 4 * 1024 * 1024 } = {}) {
    this.maxFrameBytes = maxFrameBytes;
    this.buffer = Buffer.alloc(0);
    this.discardedBytes = 0;
  }

  reset() {
    this.buffer = Buffer.alloc(0);
  }

  // Returns every complete frame contained in the bytes received so far.
  push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk);
    const frames = [];
    for (;;) {
      const headerEnd = this.buffer.indexOf(HEADER_END);
      if (headerEnd < 0) {
        if (this.buffer.length > MAX_HEADER_BYTES) this._discard(this.buffer.length - 3);
        break;
      }
      if (headerEnd > MAX_HEADER_BYTES) {
        this._discard(headerEnd + HEADER_END.length);
        continue;
      }
      const header = this.buffer.subarray(0, headerEnd).toString("latin1");
      const bodyStart = headerEnd + HEADER_END.length;
      const declared = /content-length:\s*(\d+)/i.exec(header);
      if (declared) {
        const length = Number(declared[1]);
        if (!Number.isSafeInteger(length) || length <= 0 || length > this.maxFrameBytes) {
          this._discard(bodyStart);
          continue;
        }
        if (this.buffer.length < bodyStart + length) break; // wait for the rest
        frames.push(Buffer.from(this.buffer.subarray(bodyStart, bodyStart + length)));
        this.buffer = this.buffer.subarray(bodyStart + length);
        continue;
      }
      // No Content-Length: find one whole JPEG in the body.
      const start = this.buffer.indexOf(JPEG_SOI, bodyStart);
      if (start < 0) {
        if (this.buffer.length - bodyStart > this.maxFrameBytes) this._discard(this.buffer.length);
        break;
      }
      const end = this.buffer.indexOf(JPEG_EOI, start + 2);
      if (end < 0) {
        if (this.buffer.length - start > this.maxFrameBytes) this._discard(this.buffer.length);
        break;
      }
      frames.push(Buffer.from(this.buffer.subarray(start, end + 2)));
      this.buffer = this.buffer.subarray(end + 2);
    }
    return frames;
  }

  _discard(count) {
    this.discardedBytes += count;
    this.buffer = this.buffer.subarray(count);
  }
}
