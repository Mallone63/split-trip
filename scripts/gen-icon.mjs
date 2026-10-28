// Generates the PWA icons (PNG) with zero dependencies: raw pixel math + zlib.
// Run with: npm run gen:icons
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = join(root, 'public');
mkdirSync(publicDir, { recursive: true });

// ---- Minimal PNG encoder -------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter type: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- Icon design: teal gradient, white pie split into 3 slices -----------

const BG_TOP = [13, 148, 136]; // teal-600
const BG_BOTTOM = [15, 118, 110]; // teal-700
const WEDGES = [
  [255, 255, 255], // white
  [251, 191, 36], // amber-400
  [248, 113, 113], // red-400
];

function lerp(a, b, t) {
  return Math.round(a + (b - a) * t);
}

function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.36;
  const gap = 0.022; // background gap between slices, as a fraction of one slice
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const t = y / (size - 1);
      let cr = lerp(BG_TOP[0], BG_BOTTOM[0], t);
      let cg = lerp(BG_TOP[1], BG_BOTTOM[1], t);
      let cb = lerp(BG_TOP[2], BG_BOTTOM[2], t);

      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const dist = Math.hypot(dx, dy);
      if (dist <= r) {
        const u = (Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI); // angle → 0..1
        const seg = Math.min(2, Math.floor(u * 3));
        const posInSeg = u * 3 - seg;
        let wedge = WEDGES[seg];
        if (posInSeg < gap || posInSeg > 1 - gap) wedge = [cr, cg, cb];
        const edge = r - dist;
        const aa = Math.max(0, Math.min(1, (edge + 1.2) / 2.4)); // soften circle edge
        cr = lerp(cr, wedge[0], aa);
        cg = lerp(cg, wedge[1], aa);
        cb = lerp(cb, wedge[2], aa);
      }

      const offset = (y * size + x) * 4;
      rgba[offset] = cr;
      rgba[offset + 1] = cg;
      rgba[offset + 2] = cb;
      rgba[offset + 3] = 255;
    }
  }
  return encodePng(size, size, rgba);
}

for (const [name, size] of [
  ['icon-512.png', 512],
  ['icon-192.png', 192],
  ['apple-touch-icon.png', 180],
]) {
  writeFileSync(join(publicDir, name), render(size));
  console.log(`wrote public/${name} (${size}x${size})`);
}
