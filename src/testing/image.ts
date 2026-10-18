import { deflateSync } from "node:zlib";

// A valid single-row RGBA PNG (1x1 by default), generated without image binaries or network fixtures.
export function tinyPng(width = 1): Buffer<ArrayBuffer> {
  const chunk = (name: string, data: Buffer): Buffer => {
    const type = Buffer.from(name), payload = Buffer.concat([type, data]);
    let crc = 0xffffffff;
    for (const byte of payload) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, payload, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc(1 + width * 4);
  for (let column = 0; column < width; column++) pixels.set([255, 0, 0, 255], 1 + column * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}
