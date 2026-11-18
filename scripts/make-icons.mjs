import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_BUILD = path.join(root, 'build');
const OUT_LANDING = path.join(root, 'landing', 'assets');
fs.mkdirSync(OUT_BUILD, { recursive: true });
fs.mkdirSync(OUT_LANDING, { recursive: true });

const SIZE = 512;
const LIME = [217, 249, 157];
const DARK_A = [9, 13, 7];
const DARK_B = [26, 35, 18];

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function insideRoundedRect(x, y, radius) {
  const nearestX = Math.min(Math.max(x, radius), 1 - radius);
  const nearestY = Math.min(Math.max(y, radius), 1 - radius);
  return Math.hypot(x - nearestX, y - nearestY) <= radius + 1e-9;
}

function pointInTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

function sample(x, y) {
  if (!insideRoundedRect(x, y, 0.225)) return [0, 0, 0, 0];

  const t = y;
  let r = DARK_A[0] + (DARK_B[0] - DARK_A[0]) * t;
  let g = DARK_A[1] + (DARK_B[1] - DARK_A[1]) * t;
  let b = DARK_A[2] + (DARK_B[2] - DARK_A[2]) * t;

  const glow = Math.max(0, 1 - Math.hypot(x - 0.22, y - 0.12) / 0.72);
  const glowAmount = glow * glow * 0.1;
  r += LIME[0] * glowAmount;
  g += LIME[1] * glowAmount;
  b += LIME[2] * glowAmount;

  const dx = x - 0.5;
  const dy = y - 0.5;
  const dist = Math.hypot(dx, dy);
  const angle = Math.atan2(dy, dx);

  let accent = 0;

  // open ring
  const ringRadius = 0.302;
  const ringWidth = 0.026;
  const inGap = angle > -1.38 && angle < -0.82;
  if (Math.abs(dist - ringRadius) <= ringWidth && !inGap) accent = 1;

  // endpoint dot
  const dotX = 0.5 + Math.cos(-1.13) * ringRadius;
  const dotY = 0.5 + Math.sin(-1.13) * ringRadius;
  if (Math.hypot(x - dotX, y - dotY) <= 0.052) accent = 1;

  // play triangle
  if (pointInTriangle(x, y, 0.425, 0.385, 0.425, 0.615, 0.632, 0.5)) accent = 1;

  if (accent) {
    r = LIME[0];
    g = LIME[1];
    b = LIME[2];
  }

  return [r, g, b, 255];
}

function render(size) {
  const buffer = Buffer.alloc(size * size * 4);
  const samples = 3;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const [cr, cg, cb, ca] = sample((x + (sx + 0.5) / samples) / size, (y + (sy + 0.5) / samples) / size);
          r += cr; g += cg; b += cb; a += ca;
        }
      }
      const count = samples * samples;
      const alpha = a / count;
      const offset = (y * size + x) * 4;
      // premultiplied-ish average for edges
      const cover = alpha > 0 ? alpha / 255 : 0;
      buffer[offset] = Math.round((r / count) / (cover || 1));
      buffer[offset + 1] = Math.round((g / count) / (cover || 1));
      buffer[offset + 2] = Math.round((b / count) / (cover || 1));
      buffer[offset + 3] = Math.round(alpha);
    }
  }
  return buffer;
}

function resize(src, srcSize, dstSize) {
  const out = Buffer.alloc(dstSize * dstSize * 4);
  const scale = srcSize / dstSize;
  for (let y = 0; y < dstSize; y += 1) {
    for (let x = 0; x < dstSize; x += 1) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      const startX = Math.floor(x * scale);
      const startY = Math.floor(y * scale);
      const endX = Math.floor((x + 1) * scale);
      const endY = Math.floor((y + 1) * scale);
      for (let sy = startY; sy < endY; sy += 1) {
        for (let sx = startX; sx < endX; sx += 1) {
          const offset = (sy * srcSize + sx) * 4;
          const alpha = src[offset + 3] / 255;
          r += src[offset] * alpha;
          g += src[offset + 1] * alpha;
          b += src[offset + 2] * alpha;
          a += alpha;
          n += 1;
        }
      }
      const offset = (y * dstSize + x) * 4;
      if (a > 0) {
        out[offset] = Math.round(r / a);
        out[offset + 1] = Math.round(g / a);
        out[offset + 2] = Math.round(b / a);
        out[offset + 3] = Math.round((a / n) * 255);
      }
    }
  }
  return out;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePNG(rgba, size) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function encodeICO(rgba, baseSize) {
  const sizes = [16, 32, 48, 64, 128, 256];
  const images = sizes.map((size) => {
    const scaled = size === baseSize ? rgba : resize(rgba, baseSize, size);
    return { size, data: encodePNG(scaled, size) };
  });
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + images.length * 16;
  const directory = [];
  for (const image of images) {
    const entry = Buffer.alloc(16);
    entry[0] = image.size === 256 ? 0 : image.size;
    entry[1] = image.size === 256 ? 0 : image.size;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(image.data.length, 8);
    entry.writeUInt32LE(offset, 12);
    directory.push(entry);
    offset += image.data.length;
  }
  return Buffer.concat([header, ...directory, ...images.map((image) => image.data)]);
}

const master = render(SIZE);
const icon512 = encodePNG(master, SIZE);
const icon256 = encodePNG(resize(master, SIZE, 256), 256);
const icon64 = encodePNG(resize(master, SIZE, 64), 64);

fs.writeFileSync(path.join(OUT_BUILD, 'icon.png'), icon512);
fs.writeFileSync(path.join(OUT_BUILD, 'icon.ico'), encodeICO(master, SIZE));
fs.writeFileSync(path.join(OUT_LANDING, 'icon.png'), icon256);
fs.writeFileSync(path.join(OUT_LANDING, 'favicon.png'), icon64);

console.log('Icons written:', path.join(OUT_BUILD, 'icon.ico'), path.join(OUT_BUILD, 'icon.png'));
