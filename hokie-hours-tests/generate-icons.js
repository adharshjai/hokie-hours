"use strict";
// Writes the extension's simple clock icons using only Node built-ins.
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const outDir = path.join(__dirname, "..", "hokie-hours-extension", "icons");
const MAROON = [134, 31, 65];
const WHITE = [255, 255, 255];

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

// Coordinates run from -1 to 1 across the icon.
function sample(x, y) {
  const corner = 0.32;
  const qx = Math.abs(x) - (1 - corner);
  const qy = Math.abs(y) - (1 - corner);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - corner;
  if (outside > 0) return null;
  const radius = Math.hypot(x, y);
  const ring = radius > 0.56 && radius < 0.72;
  const minuteHand = distanceToSegment(x, y, 0, 0, 0, -0.42) < 0.075;
  const hourHand = distanceToSegment(x, y, 0, 0, 0.3, 0.14) < 0.075;
  return ring || minuteHand || hourHand ? WHITE : MAROON;
}

function renderPng(size) {
  const samples = 4;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  let offset = 0;
  for (let py = 0; py < size; py++) {
    raw[offset++] = 0;
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let hits = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const x = ((px + (sx + 0.5) / samples) / size) * 2 - 1;
          const y = ((py + (sy + 0.5) / samples) / size) * 2 - 1;
          const color = sample(x, y);
          if (!color) continue;
          r += color[0];
          g += color[1];
          b += color[2];
          hits++;
        }
      }
      raw[offset++] = hits ? Math.round(r / hits) : 0;
      raw[offset++] = hits ? Math.round(g / hits) : 0;
      raw[offset++] = hits ? Math.round(b / hits) : 0;
      raw[offset++] = Math.round((hits / (samples * samples)) * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(outDir, { recursive: true });
for (const size of [16, 48, 128]) {
  fs.writeFileSync(path.join(outDir, `icon${size}.png`), renderPng(size));
}
