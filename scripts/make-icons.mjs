// Genera los íconos PNG sin dependencias: un anillo de tiempo verde que brilla.
// Uso: npm run icons
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/icons');
fs.mkdirSync(OUT, { recursive: true });

const GREEN = [163, 235, 134]; // verde biche
const CORE = [226, 250, 214];
const BG = [3, 5, 4];
const ARC = (300 * Math.PI) / 180; // 300° de 360°: el tiempo que queda
const clamp = (v) => Math.max(0, Math.min(1, v));

function draw(size, { scale = 1, mono = false } = {}) {
  const px = Buffer.alloc(size * size * 4);
  const c = size / 2;
  const R = size * 0.28 * scale;
  const hw = size * 0.034 * scale;
  const sigma = size * 0.055 * scale;
  const sx = c, sy = c - R;
  const ex = c + R * Math.sin(ARC), ey = c - R * Math.cos(ARC);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const X = x + 0.5, Y = y + 0.5;
      const dx = X - c, dy = Y - c;
      const d = Math.hypot(dx, dy);
      let a = Math.atan2(dx, -dy);
      if (a < 0) a += 2 * Math.PI;
      const ring = Math.abs(d - R);
      const toEnd = Math.hypot(X - ex, Y - ey);
      const dist = a <= ARC ? ring : Math.min(Math.hypot(X - sx, Y - sy), toEnd);
      const core = clamp(hw - dist + 0.5);
      const ghost = clamp(hw * 0.8 - ring + 0.5);
      const i = (y * size + x) * 4;

      if (mono) {
        px[i] = px[i + 1] = px[i + 2] = 255;
        px[i + 3] = Math.round(255 * Math.max(core, ghost * 0.35));
        continue;
      }
      const glow =
        Math.exp(-(Math.max(0, dist - hw) ** 2) / (2 * sigma * sigma)) * 0.38 +
        Math.exp(-(toEnd ** 2) / (2 * (sigma * 1.1) ** 2)) * 0.32; // cabeza del arco
      const vignette = Math.max(0, 1 - d / (size * 0.75)) * 7;
      for (let k = 0; k < 3; k++) {
        let v = BG[k] + vignette + GREEN[k] * (glow + ghost * 0.12);
        v += (CORE[k] - v) * core;
        px[i + k] = Math.round(Math.min(255, v));
      }
      px[i + 3] = 255;
    }
  }
  return png(size, px);
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bits por canal
  ihdr[9] = 6; // RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const icons = {
  'icon-192.png': draw(192),
  'icon-512.png': draw(512),
  'icon-maskable-512.png': draw(512, { scale: 0.86 }),
  'apple-touch-icon.png': draw(180),
  'badge-96.png': draw(96, { scale: 1.25, mono: true }),
};
for (const [name, buf] of Object.entries(icons)) {
  fs.writeFileSync(path.join(OUT, name), buf);
  console.log(`${name.padEnd(24)} ${(buf.length / 1024).toFixed(1)} KB`);
}
