import { test } from "node:test";
import assert from "node:assert/strict";
import { MjpegParser, frameKind } from "../../src/mjpegParser.js";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 0xff, 0xd9]);
const JPEG_B = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 9, 9, 9, 0xff, 0xd9]);

function part(frame, { withLength = true, boundary = "--BoundaryString", type = "image/jpeg" } = {}) {
  return Buffer.concat([
    Buffer.from(`${boundary}\r\nContent-type: ${type}\r\n${withLength ? `Content-Length: ${frame.length}\r\n` : ""}\r\n`),
    frame,
    Buffer.from("\r\n"),
  ]);
}

test("one part yields one frame, byte for byte", () => {
  const parser = new MjpegParser();
  const frames = parser.push(part(JPEG));
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], JPEG);
});

test("several frames in one chunk come out in order", () => {
  const parser = new MjpegParser();
  const frames = parser.push(Buffer.concat([part(JPEG), part(JPEG_B), part(JPEG)]));
  assert.deepEqual(frames, [JPEG, JPEG_B, JPEG]);
});

test("a frame split across arbitrary chunk boundaries (even mid-header) is reassembled", () => {
  const whole = Buffer.concat([part(JPEG), part(JPEG_B)]);
  for (let size = 1; size <= whole.length; size += 1) {
    const parser = new MjpegParser();
    const frames = [];
    for (let offset = 0; offset < whole.length; offset += size) frames.push(...parser.push(whole.subarray(offset, offset + size)));
    assert.deepEqual(frames, [JPEG, JPEG_B], `chunk size ${size}`);
  }
});

test("frame bytes that happen to contain CRLFCRLF or boundary text are not misread (Content-Length wins)", () => {
  const tricky = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from("\r\n\r\n--BoundaryString\r\n"), Buffer.from([0xff, 0xd9])]);
  const parser = new MjpegParser();
  const frames = parser.push(Buffer.concat([part(tricky), part(JPEG)]));
  assert.deepEqual(frames, [tricky, JPEG]);
});

test("without Content-Length the parser falls back to the JPEG start/end markers", () => {
  const parser = new MjpegParser();
  const frames = parser.push(Buffer.concat([part(JPEG, { withLength: false }), part(JPEG_B, { withLength: false })]));
  assert.deepEqual(frames, [JPEG, JPEG_B]);
});

test("an absurd or negative Content-Length resynchronises instead of allocating or hanging", () => {
  const parser = new MjpegParser({ maxFrameBytes: 1024 });
  const bad = Buffer.from("--BoundaryString\r\nContent-Length: 99999999\r\n\r\n");
  const frames = parser.push(Buffer.concat([bad, part(JPEG)]));
  assert.deepEqual(frames, [JPEG]);
});

test("garbage with no header terminator does not grow the buffer without bound", () => {
  const parser = new MjpegParser();
  parser.push(Buffer.alloc(200_000, 0x41));
  assert.ok(parser.buffer.length < 10_000);
  assert.ok(parser.discardedBytes > 100_000);
  assert.deepEqual(parser.push(part(JPEG)), [JPEG], "still recovers after the garbage");
});

test("frameKind identifies the mock phone's SVG frames", () => {
  assert.equal(frameKind(Buffer.from('<svg viewBox="0 0 1 1"></svg>')), 3);
});

test("frameKind identifies JPEG, PNG and unknown payloads", () => {
  assert.equal(frameKind(JPEG), 1);
  assert.equal(frameKind(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d])), 2);
  assert.equal(frameKind(Buffer.from("hello")), 0);
  assert.equal(frameKind(Buffer.alloc(0)), 0);
  assert.equal(frameKind(null), 0);
});
