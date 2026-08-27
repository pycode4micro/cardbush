const { app, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const sourcePath = path.join(projectRoot, 'public', 'cardbush-logo.png');
const outputPath = path.join(projectRoot, 'assets', 'cardbush.ico');
const iconSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];

app.whenReady().then(() => {
  const source = nativeImage.createFromPath(sourcePath);
  if (source.isEmpty()) {
    throw new Error(`Unable to load CardBush logo: ${sourcePath}`);
  }
  const cropped = cropTransparentPadding(source);
  const images = iconSizes.map((size) => ({
    size,
    data: cropped.resize({ width: size, height: size, quality: 'best' }).toPNG(),
  }));
  fs.writeFileSync(outputPath, buildPngIcon(images));
  console.log(`Generated ${outputPath} with ${images.length} image sizes.`);
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});

function cropTransparentPadding(image) {
  const { width, height } = image.getSize();
  const bitmap = image.toBitmap({ scaleFactor: 1 });
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if ((bitmap[(y * width + x) * 4 + 3] ?? 0) <= 8) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < minX || maxY < minY) return image;
  const contentWidth = maxX - minX + 1;
  const contentHeight = maxY - minY + 1;
  const safePadding = Math.ceil(Math.max(contentWidth, contentHeight) * 0.06);
  const side = Math.min(
    width,
    height,
    Math.max(contentWidth, contentHeight) + safePadding * 2,
  );
  const centerX = (minX + maxX + 1) / 2;
  const centerY = (minY + maxY + 1) / 2;
  const x = Math.max(0, Math.min(width - side, Math.round(centerX - side / 2)));
  const y = Math.max(0, Math.min(height - side, Math.round(centerY - side / 2)));
  return image.crop({ x, y, width: side, height: side });
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
