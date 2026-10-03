import { test } from "node:test";
import assert from "node:assert/strict";
import {
  safeFilename, safeDeviceId, deviceDir, MEDIA_ROOT, assertMediaStorageIsolated,
  rejectedMediaUploadReason, detectMediaMagic, rejectedMediaContentReason,
} from "../../src/fileStore.js";

test("safeFilename accepts a plain filename", () => {
  assert.equal(safeFilename("clip.mp4"), "clip.mp4");
  assert.equal(safeFilename("photo 1.jpg"), "photo 1.jpg");
});

test("safeFilename rejects path traversal", () => {
  assert.equal(safeFilename("../secrets.txt"), null);
  assert.equal(safeFilename("..\\secrets.txt"), null);
  assert.equal(safeFilename("a/../../b"), null);
});

test("safeFilename rejects a leading dot", () => {
  assert.equal(safeFilename(".env"), null);
  assert.equal(safeFilename(".hidden"), null);
});

test("safeFilename rejects path separators", () => {
  assert.equal(safeFilename("a/b.txt"), null);
  assert.equal(safeFilename("a\\b.txt"), null);
});

// Production-readiness audit §3: previously no file-type restriction at
// all — any extension, any declared MIME type, was accepted as-is.
test("rejectedMediaUploadReason accepts every allowed video/image/audio extension with its matching MIME type", () => {
  const allowed = [
    ["clip.mp4", "video/mp4"], ["clip.m4v", "video/x-m4v"], ["clip.mov", "video/quicktime"],
    ["clip.webm", "video/webm"], ["photo.jpg", "image/jpeg"], ["photo.jpeg", "image/jpeg"],
    ["photo.png", "image/png"], ["photo.gif", "image/gif"], ["photo.webp", "image/webp"],
    ["photo.heic", "image/heic"], ["photo.heif", "image/heif"], ["sound.mp3", "audio/mpeg"],
    ["sound.m4a", "audio/mp4"], ["sound.wav", "audio/wav"], ["sound.aac", "audio/aac"],
  ];
  for (const [name, mimetype] of allowed) {
    assert.equal(rejectedMediaUploadReason(name, mimetype), null, `${name} (${mimetype}) should be allowed`);
  }
});

test("rejectedMediaUploadReason rejects a disallowed extension", () => {
  assert.match(rejectedMediaUploadReason("payload.html", "text/html"), /not allowed/);
  assert.match(rejectedMediaUploadReason("payload.svg", "image/svg+xml"), /not allowed/);
  assert.match(rejectedMediaUploadReason("payload.exe", "application/octet-stream"), /not allowed/);
  assert.match(rejectedMediaUploadReason("no-extension-at-all", "video/mp4"), /not allowed/);
});

test("rejectedMediaUploadReason rejects an extension/MIME-type mismatch (a spoofed declared type)", () => {
  assert.match(rejectedMediaUploadReason("clip.mp4", "text/html"), /does not match/);
  assert.match(rejectedMediaUploadReason("photo.png", "image/svg+xml"), /does not match/);
  assert.match(rejectedMediaUploadReason("clip.mp4", "image/png"), /does not match/);
});

test("media magic detection recognizes every allowed container family", () => {
  const fixtures = [
    [Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "jpeg"],
    [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "png"],
    [Buffer.from("GIF89a"), "gif"],
    [Buffer.from("RIFF0000WEBP"), "webp"],
    [Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), "webm"],
    [Buffer.from("0000ftypisom0000isommp42"), "mp4"],
    [Buffer.from("0000ftypqt  0000qt  "), "quicktime"],
    [Buffer.from("0000ftypM4A 0000M4A "), "m4a"],
    [Buffer.from("0000ftypheic0000mif1heic"), "heif"],
    [Buffer.from("ID3\u0004"), "mp3"],
    [Buffer.from("RIFF0000WAVE"), "wav"],
    [Buffer.from([0xff, 0xf1, 0x50, 0x80]), "aac"],
  ];
  for (const [bytes, expected] of fixtures) assert.equal(detectMediaMagic(bytes), expected);
});

test("media content validation rejects spoofed, mismatched, and truncated uploads", () => {
  const mp4 = Buffer.from("0000ftypisom0000isommp42");
  assert.equal(rejectedMediaContentReason("clip.mp4", mp4), null);
  assert.match(rejectedMediaContentReason("clip.mp4", Buffer.from("<script>alert(1)</script>")), /supported media format/);
  assert.match(rejectedMediaContentReason("photo.png", mp4), /do not match/);
  assert.match(rejectedMediaContentReason("photo.jpg", Buffer.from([0xff, 0xd8])), /supported media format/);
});

test("safeFilename rejects header-unsafe and control characters", () => {
  assert.equal(safeFilename('quote"name.txt'), null);
  assert.equal(safeFilename("cr\rlf\nname.txt"), null);
  assert.equal(safeFilename("null\x00byte.txt"), null);
  assert.equal(safeFilename("wild*card?.txt"), null);
  assert.equal(safeFilename("colon:name.txt"), null);
});

test("safeFilename rejects empty, non-string, and oversized names", () => {
  assert.equal(safeFilename(""), null);
  assert.equal(safeFilename(undefined), null);
  assert.equal(safeFilename(123), null);
  assert.equal(safeFilename("a".repeat(256)), null);
  assert.equal(safeFilename("a".repeat(255)), "a".repeat(255));
});

test("safeDeviceId accepts alphanumeric/dash/underscore ids", () => {
  assert.equal(safeDeviceId("mock-1"), "mock-1");
  assert.equal(safeDeviceId("iphone_2"), "iphone_2");
});

test("safeDeviceId rejects traversal and unsafe characters", () => {
  assert.equal(safeDeviceId("../etc"), null);
  assert.equal(safeDeviceId("mock 1"), null);
  assert.equal(safeDeviceId("mock/1"), null);
  assert.equal(safeDeviceId(""), null);
  assert.equal(safeDeviceId(undefined), null);
});

test("media namespace rejects internal device names and overlapping storage", () => {
  for (const id of ["sessions", "Sessions", "queue", "research", "audit", "models"]) {
    assert.equal(safeDeviceId(id), null);
    assert.equal(deviceDir(id), null);
  }
  assert.ok(deviceDir("phone").startsWith(MEDIA_ROOT));
  assert.throws(() => assertMediaStorageIsolated([MEDIA_ROOT]), /overlaps/);
  assert.throws(() => assertMediaStorageIsolated([deviceDir("phone")]), /overlaps/);
});
