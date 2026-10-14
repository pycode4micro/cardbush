import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

/** Keep PDF fonts, CMaps and codecs local in both packaged and development builds. */
export function pdfPreviewAssetsPlugin() {
  const require = createRequire(import.meta.url);
  const directory = path.dirname(require.resolve('pdfjs-dist/package.json'));
  const prefix = `assets/pdfjs-${JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8')).version}/`;
  const files = new Map();
  for (const folder of ['cmaps', 'standard_fonts', 'wasm']) {
    for (const name of readdirSync(path.join(directory, folder))) {
      if (!/\.(bcmap|pfb|ttf|wasm)$/.test(name)) continue;
      files.set(prefix + folder + '/' + name, path.join(directory, folder, name));
    }
  }
  return {
    name: 'cardbush-pdf-preview-assets',
    buildStart() {
      for (const [fileName, source] of files) this.emitFile({ type: 'asset', fileName, source: readFileSync(source) });
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const source = files.get((request.url || '').split('?')[0].replace(/^\//, ''));
        if (!source) return next();
        response.setHeader('Content-Type', source.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream');
        response.end(readFileSync(source));
      });
    },
  };
}
