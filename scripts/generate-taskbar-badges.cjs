const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');

// Bake the artwork once; changing the unread count never loads a font or a renderer.
async function generate() {
  const assets = path.join(__dirname, '..', 'assets');
  const template = await fs.readFile(path.join(assets, 'brand', 'unread-badge.svg'), 'utf8');
  const tiles = Array.from({ length: 100 }, (_, index) => {
    const label = index === 99 ? '99+' : String(index + 1);
    const svg = template.replace('{label}', label).replace('{size}', ['36', '30', '22'][label.length - 1]);
    return { input: Buffer.from(svg), left: (index % 10) * 48, top: Math.floor(index / 10) * 48 };
  });
  await sharp({ create: { width: 480, height: 480, channels: 4, background: '#00000000' } })
    .composite(tiles).png({ palette: true }).toFile(path.join(assets, 'tray', 'unread-badges.png'));
}
generate().catch(error => { console.error(error); process.exitCode = 1; });
