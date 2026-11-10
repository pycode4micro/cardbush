const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');

const projectRoot = path.resolve(__dirname, '..');
const assets = path.join(projectRoot, 'assets');
const brand = path.join(assets, 'brand');
const iconSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];

async function generate() {
  const mark = path.join(brand, 'cardbush-black.svg');
  const tile = path.join(brand, 'system-icon-tile.svg');
  await sharp(mark).resize(1024).png().toFile(path.join(projectRoot, 'public/cardbush-logo.png'));

  // OS and browser extension icons share one asset across light and dark surfaces.
  const foreground = await sharp(mark).resize(884).png().toBuffer();
  const systemIcon = await sharp(tile).resize(1024).composite([{ input: foreground }]).png().toBuffer();
  await fs.writeFile(path.join(assets, 'cardbush-app-icon.png'), systemIcon);

  const images = await Promise.all(iconSizes.map(async size => ({
    size,
    data: await sharp(systemIcon).resize(size).png().toBuffer(),
  })));
  await fs.writeFile(path.join(assets, 'cardbush.ico'), buildPngIcon(images));

  const extensionIcons = path.join(assets, 'plugins/browser/extension/icons');
  for (const { size, data } of images) {
    if ([16, 32, 48, 128].includes(size)) {
      await fs.writeFile(path.join(extensionIcons, `cardbush-${size}.png`), data);
    }
  }
}

function buildPngIcon(images) {
  const headerSize = 6 + images.length * 16;
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = headerSize;
  images.forEach(({ size, data }, index) => {
    const entry = 6 + index * 16;
    header.writeUInt8(size >= 256 ? 0 : size, entry);
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    header.writeUInt8(0, entry + 2);
    header.writeUInt8(0, entry + 3);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(data.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map(({ data }) => data)]);
}

generate().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
