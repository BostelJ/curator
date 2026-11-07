// Draws Curator's logo without any image library: a solid instant print, tilted 8° clockwise,
// its window as negative space. Same geometry as brand/*.svg, on the logo's 512 grid.
const zlib = require('zlib');

const TILT = (8 * Math.PI) / 180;
const COS = Math.cos(-TILT);
const SIN = Math.sin(-TILT);

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** Is this point (on the 512 grid) on the print? Undo the tilt, then test the card minus its window. */
function onPrint(x, y) {
  const dx = x - 256, dy = y - 256;
  const ux = 256 + dx * COS - dy * SIN;
  const uy = 256 + dx * SIN + dy * COS;
  return inRoundRect(ux, uy, 116, 86, 396, 426, 8) && !(ux > 144 && ux < 368 && uy > 114 && uy < 338);
}

function hex(color) {
  const n = parseInt(color.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * RGBA pixels for a square icon of `size`.
 *  tile: draw the app icon's rounded paper tile behind the print (for the .ico); else just the print.
 *  dot: a red dot in the corner, for "something's waiting".
 */
function drawLogo(size, { ink = '#111010', tile = false, dot = false, alpha = 1 } = {}) {
  const px = Buffer.alloc(size * size * 4);
  const SS = 4; // supersamples per side
  const [ir, ig, ib] = hex(ink);
  const [pr, pg, pb] = hex('#fbfaf6');
  const [mr, mg, mb] = hex('#e5391f');
  // Map pixel space onto the 512 grid: the app icon uses the 1024 artwork, the tray symbol its 384 box.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let a = 0, rr = 0, gg = 0, bb = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = (x + (sx + 0.5) / SS) / size;
          const fy = (y + (sy + 0.5) / SS) / size;
          let c = null;
          if (tile) {
            const X = fx * 1024, Y = fy * 1024;
            if (inRoundRect(X, Y, 100, 100, 924, 924, 186)) {
              c = [pr, pg, pb];
              if (onPrint((X - 76.8) / 1.7, (Y - 76.8) / 1.7)) c = [ir, ig, ib];
            }
          } else {
            const X = 64 + fx * 384, Y = 64 + fy * 384;
            if (onPrint(X, Y)) c = [ir, ig, ib];
          }
          if (dot) {
            const d = Math.hypot(fx - 0.8, fy - 0.2);
            if (d < 0.2) c = [mr, mg, mb];
            else if (d < 0.27 && c) c = null; // a gap around the dot so it reads at 16px
          }
          if (c) { a++; rr += c[0]; gg += c[1]; bb += c[2]; }
        }
      }
      const i = (y * size + x) * 4;
      if (a) {
        px[i] = Math.round(rr / a); px[i + 1] = Math.round(gg / a); px[i + 2] = Math.round(bb / a);
        px[i + 3] = Math.round((a / (SS * SS)) * 255 * alpha);
      }
    }
  }
  return px;
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A Windows .ico holding a PNG for each size (Vista and later read these). */
function ico(images) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { size, data } of images) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8); e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
  }
  return Buffer.concat([head, ...entries, ...images.map((i) => i.data)]);
}

module.exports = { drawLogo, png, ico };
