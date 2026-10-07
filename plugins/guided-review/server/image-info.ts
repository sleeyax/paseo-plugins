/** The image formats the panel's `Image` draws on every platform; SVG is not one of them. */
export type ImageMimeType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export type ImageInfo = { mimeType: ImageMimeType; width: number; height: number };

/** The format and pixel size an image's header gives, or null for anything that is not one of `ImageMimeType`. */
export function imageInfo(bytes: Buffer): ImageInfo | null {
  const info = png(bytes) ?? gif(bytes) ?? jpeg(bytes) ?? webp(bytes);
  return info !== null && info.width > 0 && info.height > 0 ? info : null;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function png(bytes: Buffer): ImageInfo | null {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  return { mimeType: "image/png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function gif(bytes: Buffer): ImageInfo | null {
  const signature = bytes.subarray(0, 6).toString("latin1");
  if (bytes.length < 10 || (signature !== "GIF87a" && signature !== "GIF89a")) return null;
  return { mimeType: "image/gif", width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
}

/** Walks the segments to the first start-of-frame, which holds the size; DHT, JPG and DAC share its marker range but are no frame. */
function jpeg(bytes: Buffer): ImageInfo | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (offset + 9 > bytes.length) return null;
      return { mimeType: "image/jpeg", width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
    }
    offset += 2 + bytes.readUInt16BE(offset + 2);
  }
  return null;
}

function webp(bytes: Buffer): ImageInfo | null {
  if (bytes.length < 30 || bytes.toString("latin1", 0, 4) !== "RIFF" || bytes.toString("latin1", 8, 12) !== "WEBP") return null;
  const chunk = bytes.toString("latin1", 12, 16);
  if (chunk === "VP8 ") {
    return { mimeType: "image/webp", width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    const bits = bytes.readUInt32LE(21);
    return { mimeType: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") {
    return { mimeType: "image/webp", width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
  }
  return null;
}
