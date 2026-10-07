import assert from "node:assert/strict";
import test from "node:test";
import { imageInfo } from "./image-info.ts";

function png(width: number, height: number): Buffer {
  const header = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header);
  header.write("IHDR", 12, "latin1");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

function riff(chunk: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(20);
  head.write("RIFF", 0, "latin1");
  head.write("WEBP", 8, "latin1");
  head.write(chunk, 12, "latin1");
  return Buffer.concat([head, payload, Buffer.alloc(16)]);
}

test("reads a PNG's size from its header", () => {
  assert.deepEqual(imageInfo(png(594, 890)), { mimeType: "image/png", width: 594, height: 890 });
});

test("reads a GIF's size, little-endian", () => {
  const gif = Buffer.from([...Buffer.from("GIF89a", "latin1"), 0x40, 0x01, 0xc8, 0x00]);
  assert.deepEqual(imageInfo(gif), { mimeType: "image/gif", width: 320, height: 200 });
});

test("reads a JPEG's size from its first frame, past the segments before it and the DHT that shares the frame markers", () => {
  const app0 = [0xff, 0xe0, 0x00, 0x04, 0x00, 0x00];
  const dht = [0xff, 0xc4, 0x00, 0x04, 0x00, 0x00];
  const sof2 = [0xff, 0xc2, 0x00, 0x0b, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0x01];
  assert.deepEqual(imageInfo(Buffer.from([0xff, 0xd8, ...app0, ...dht, ...sof2])), { mimeType: "image/jpeg", width: 640, height: 480 });
});

test("reads each kind of WebP's size", () => {
  const lossy = Buffer.alloc(10);
  lossy.writeUInt16LE(800, 6);
  lossy.writeUInt16LE(600, 8);
  assert.deepEqual(imageInfo(riff("VP8 ", lossy)), { mimeType: "image/webp", width: 800, height: 600 });

  const lossless = Buffer.alloc(5);
  lossless[0] = 0x2f;
  lossless.writeUInt32LE((800 - 1) | ((600 - 1) << 14), 1);
  assert.deepEqual(imageInfo(riff("VP8L", lossless)), { mimeType: "image/webp", width: 800, height: 600 });

  const extended = Buffer.alloc(10);
  extended.writeUIntLE(800 - 1, 4, 3);
  extended.writeUIntLE(600 - 1, 7, 3);
  assert.deepEqual(imageInfo(riff("VP8X", extended)), { mimeType: "image/webp", width: 800, height: 600 });
});

test("anything else, an SVG or a page a redirect ended on included, is no image the panel draws", () => {
  assert.equal(imageInfo(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"></svg>')), null);
  assert.equal(imageInfo(Buffer.from("<!DOCTYPE html><html>")), null);
  assert.equal(imageInfo(png(0, 10)), null);
});
