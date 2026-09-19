/**
 * 生成桌面壳的占位图标源图（1024×1024 PNG），交给 `tauri icon` 派生整套尺寸。
 * 这是占位图，不是品牌图标 —— 设计稿到位后替换本文件并重跑同一条命令即可。
 */

import { deflateSync } from 'zlib';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const SIZE = 1024;
const RADIUS = 200; // 圆角半径
const STROKE = 92; // 字形笔画宽度
const BG = [22, 119, 255]; // 与管理台顶部栏一致的蓝
const FG = [255, 255, 255];
const SAMPLES = 3; // 每像素 3×3 超采样，避免缩到 16px 托盘尺寸时锯齿

// "M" 字形：两根竖笔 + 两条斜笔
const SEGMENTS = [
  [[306, 700], [306, 324]],
  [[306, 324], [512, 616]],
  [[512, 616], [718, 324]],
  [[718, 324], [718, 700]],
];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function inRoundedSquare(x, y) {
  const lo = RADIUS;
  const hi = SIZE - 1 - RADIUS;
  const cx = Math.min(Math.max(x, lo), hi);
  const cy = Math.min(Math.max(y, lo), hi);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= RADIUS * RADIUS;
}

function distToSegment(px, py, a, b) {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const wx = px - a[0];
  const wy = py - a[1];
  const len2 = vx * vx + vy * vy;
  let t = len2 === 0 ? 0 : (wx * vx + wy * vy) / len2;
  t = Math.max(0, Math.min(1, t));
  const dx = px - (a[0] + t * vx);
  const dy = py - (a[1] + t * vy);
  return Math.sqrt(dx * dx + dy * dy);
}

function inGlyph(x, y) {
  return SEGMENTS.some((s) => distToSegment(x, y, s[0], s[1]) <= STROKE / 2);
}

function buildRaw() {
  const raw = Buffer.alloc(SIZE * (1 + SIZE * 4));
  const step = 1 / SAMPLES;
  for (let y = 0; y < SIZE; y++) {
    const rowStart = y * (1 + SIZE * 4);
    raw[rowStart] = 0; // filter type: None
    for (let x = 0; x < SIZE; x++) {
      let bgHits = 0;
      let fgHits = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const px = x + (sx + 0.5) * step;
          const py = y + (sy + 0.5) * step;
          if (inRoundedSquare(px, py)) {
            bgHits++;
            if (inGlyph(px, py)) fgHits++;
          }
        }
      }
      const total = SAMPLES * SAMPLES;
      const bgAlpha = bgHits / total;
      const fgAlpha = fgHits / total;
      // 前景压在后景上，得到抗锯齿后的最终颜色与透明度
      const offset = rowStart + 1 + x * 4;
      raw[offset] = Math.round(BG[0] * (1 - fgAlpha) + FG[0] * fgAlpha);
      raw[offset + 1] = Math.round(BG[1] * (1 - fgAlpha) + FG[1] * fgAlpha);
      raw[offset + 2] = Math.round(BG[2] * (1 - fgAlpha) + FG[2] * fgAlpha);
      raw[offset + 3] = Math.round(bgAlpha * 255);
    }
  }
  return raw;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type: RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(buildRaw(), { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'src-tauri');
mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'icon-source.png');
writeFileSync(outFile, png);
console.log(`占位图标源图已生成: ${path.relative(root, outFile)} (${png.length} bytes, ${SIZE}×${SIZE})`);
