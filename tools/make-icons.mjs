/* ============================================================
 * tools/make-icons.mjs —— 零依赖生成扩展图标（PNG）
 * ------------------------------------------------------------
 * chrome.notifications 必须要有 iconUrl，所以我们需要真实的 PNG 文件。
 * 用法：node tools/make-icons.mjs
 * 输出：icons/icon16.png、icons/icon48.png、icons/icon128.png
 * ============================================================ */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ---------------- 最小 PNG 编码器 ---------------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------------- 画布（带 alpha 混合） ---------------- */
function createCanvas(w, h) {
  return { w, h, buf: Buffer.alloc(w * h * 4) };
}

function blend(c, x, y, [r, g, b], a) {
  if (x < 0 || y < 0 || x >= c.w || y >= c.h || a <= 0) return;
  const i = (y * c.w + x) * 4;
  const da = c.buf[i + 3] / 255;
  const outA = a + da * (1 - a);
  if (outA <= 0) return;
  const mix = (src, dst) => Math.round((src * a + dst * da * (1 - a)) / outA);
  c.buf[i] = mix(r, c.buf[i]);
  c.buf[i + 1] = mix(g, c.buf[i + 1]);
  c.buf[i + 2] = mix(b, c.buf[i + 2]);
  c.buf[i + 3] = Math.round(outA * 255);
}

function fillRoundRect(c, x0, y0, x1, y1, radius, color) {
  for (let y = Math.floor(y0); y < y1; y++) {
    for (let x = Math.floor(x0); x < x1; x++) {
      // 圆角距离场
      const dx = Math.max(x0 + radius - x, 0, x - (x1 - 1 - radius));
      const dy = Math.max(y0 + radius - y, 0, y - (y1 - 1 - radius));
      const d = Math.sqrt(dx * dx + dy * dy);
      const a = Math.max(0, Math.min(1, radius - d + 0.5));
      if (a > 0) blend(c, x, y, color, a);
    }
  }
}

function thickSegment(c, x1, y1, x2, y2, thickness, color) {
  const half = thickness / 2;
  const minX = Math.floor(Math.min(x1, x2) - half - 1);
  const maxX = Math.ceil(Math.max(x1, x2) + half + 1);
  const minY = Math.floor(Math.min(y1, y2) - half - 1);
  const maxY = Math.ceil(Math.max(y1, y2) + half + 1);
  const vx = x2 - x1, vy = y2 - y1;
  const len2 = vx * vx + vy * vy || 1;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      let t = ((x - x1) * vx + (y - y1) * vy) / len2;
      t = Math.max(0, Math.min(1, t));
      const px = x1 + t * vx, py = y1 + t * vy;
      const d = Math.hypot(x - px, y - py);
      const a = Math.max(0, Math.min(1, half - d + 0.5));
      if (a > 0) blend(c, x, y, color, a);
    }
  }
}

/* ---------------- 图标绘制：蓝底 + 白色对勾 ---------------- */
function drawIcon(size) {
  const c = createCanvas(size, size);
  const s = size / 128;              // 以 128 为基准缩放
  const bg = [30, 64, 175];          // #1e40af
  const bg2 = [37, 99, 235];         // #2563eb
  fillRoundRect(c, 0, 0, size, size, 28 * s, bg);
  // 顶部渐亮：画一条斜向高光
  thickSegment(c, size * 0.15, size * 0.9, size * 0.9, size * 0.2, size * 0.5, bg2);
  fillRoundRect(c, 0, 0, size, size, 28 * s, [255, 255, 255]);   // 先铺白再压暗，得到干净的渐变底
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * c.w + x) * 4;
      if (c.buf[i + 3] === 0) continue;
      const t = (x + y) / (2 * size);
      c.buf[i] = Math.round(bg[0] * (1 - t) + bg2[0] * t);
      c.buf[i + 1] = Math.round(bg[1] * (1 - t) + bg2[1] * t);
      c.buf[i + 2] = Math.round(bg[2] * (1 - t) + bg2[2] * t);
    }
  }
  // 白色对勾：两段粗线
  const white = [255, 255, 255];
  thickSegment(c, size * 0.30, size * 0.53, size * 0.44, size * 0.68, 11 * s, white);
  thickSegment(c, size * 0.44, size * 0.68, size * 0.72, size * 0.34, 11 * s, white);
  return encodePng(size, size, c.buf);
}

mkdirSync(resolve(ROOT, 'icons'), { recursive: true });
for (const size of [16, 48, 128]) {
  const out = resolve(ROOT, 'icons', `icon${size}.png`);
  writeFileSync(out, drawIcon(size));
  console.log('written', out);
}
