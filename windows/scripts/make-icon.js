// Writes build/icon.ico, the app and installer icon, from the logo's geometry.
const fs = require('fs');
const path = require('path');
const { drawLogo, png, ico } = require('../src/raster');

const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const images = sizes.map((size) => ({ size, data: png(drawLogo(size, { tile: true }), size) }));
const out = path.join(__dirname, '..', 'build', 'icon.ico');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, ico(images));
if (process.argv[2]) {
  // Previews, for looking at the icons: node scripts/make-icon.js <folder>
  const dir = process.argv[2];
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'icon-256.png'), images.at(-1).data);
  for (const [name, opts] of Object.entries({
    'tray-light': {}, 'tray-dark': { ink: '#ffffff' }, 'tray-waiting': { dot: true },
    'tray-dark-waiting': { ink: '#ffffff', dot: true }, 'tray-paused': { alpha: 0.45 },
  })) {
    for (const size of [16, 32, 128]) fs.writeFileSync(path.join(dir, `${name}-${size}.png`), png(drawLogo(size, opts), size));
  }
}
console.log('Wrote', out);
