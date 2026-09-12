import { build } from 'rolldown';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const root = dirname(fileURLToPath(import.meta.url));
const out = join(root, 'plugin', 'dist');
await mkdir(out, { recursive: true });
await build({ input: join(root, 'src/entry.ts'), platform: 'node',
  output: { file: join(out, 'runtime.mjs'), format: 'esm', minify: true, codeSplitting: false } });
await build({ input: join(root, 'ui/entry.tsx'), platform: 'browser',
  transform: { define: { 'process.env.NODE_ENV': JSON.stringify('production') }, jsx: { runtime: 'automatic' } },
  plugins: [{ name: 'plugin-css', resolveId(source, importer) { if (source.endsWith('.css') || source.endsWith('.css?inline')) return resolve(dirname(importer), source); },
    async load(id) { if (id.endsWith('.css?inline')) return { code: `export default ${JSON.stringify(await readFile(id.slice(0, -7), 'utf8'))}`, moduleType: 'js' };
      if (id.endsWith('.css')) return { code: 'export default ""', moduleType: 'js' }; } }],
  output: { file: join(out, 'renderer.mjs'), format: 'esm', minify: true, codeSplitting: false } });
const manifest = JSON.parse(await readFile(join(root, 'plugin/.codex-plugin/plugin.json'), 'utf8'));
const zip = new JSZip();
async function add(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await add(path);
    else zip.file(`${manifest.name}/${relative(join(root, 'plugin'), path).replaceAll('\\', '/')}`, await readFile(path));
  }
}
await add(join(root, 'plugin'));
const release = resolve(root, '../../release-plugins');
await mkdir(release, { recursive: true });
const path = join(release, `${manifest.name}-${manifest.version}.zip`);
await writeFile(path, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
process.stdout.write(`Packaged independent Team plugin: ${path}\n`);
