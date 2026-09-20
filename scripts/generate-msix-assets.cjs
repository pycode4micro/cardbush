const { app, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

app.whenReady().then(() => {
  if (!process.argv[2]) throw new Error('An MSIX asset output directory is required.');
  const output = path.resolve(process.argv[2]);
  const source = nativeImage.createFromPath(path.join(__dirname, '../assets/cardbush.ico'));
  if (source.isEmpty()) throw new Error('CardBush icon could not be loaded.');
  fs.mkdirSync(output, { recursive: true });
  for (const [name, width, height] of [
    ['StoreLogo.png', 50, 50], ['Square150x150Logo.png', 150, 150],
    ['Square44x44Logo.png', 44, 44], ['Wide310x150Logo.png', 310, 150],
  ]) {
    const side = Math.min(width, height);
    const image = source.resize({ width: side, height: side, quality: 'best' });
    const pixels = image.toBitmap({ scaleFactor: 1 });
    const canvas = Buffer.alloc(width * height * 4);
    const left = Math.floor((width - side) / 2);
    const top = Math.floor((height - side) / 2);
    for (let row = 0; row < side; row++) {
      pixels.copy(canvas, ((top + row) * width + left) * 4, row * side * 4, (row + 1) * side * 4);
    }
    fs.writeFileSync(path.join(output, name), nativeImage.createFromBitmap(canvas, { width, height, scaleFactor: 1 }).toPNG());
  }
  console.log(`Generated CardBush MSIX assets in ${output}`);
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
