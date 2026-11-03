import { build } from 'vite';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';

const result = await build({
  root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, publicDir: false,
  ssr: { noExternal: true },
  build: { ssr: 'assets/plugins/agentchatroom/src/index.ts', target: 'node24', write: false,
    outDir: 'assets/plugins/agentchatroom/runtime', emptyOutDir: false, minify: false,
    rolldownOptions: { output: { entryFileNames: 'index.mjs', codeSplitting: false } } },
});
// Windows may memory-map a running plugin. Keep identical output untouched;
// changed output is replaced atomically rather than truncating a loaded module.
const directory = fileURLToPath(new URL('../assets/plugins/agentchatroom/runtime/', import.meta.url));
for (const bundle of Array.isArray(result) ? result : [result]) for (const item of bundle.output) {
  const file = resolve(directory, item.fileName);
  if (dirname(file) !== resolve(directory)) throw new Error('Unexpected plugin build output path.');
  const content = Buffer.from(item.type === 'chunk' ? item.code : item.source);
  const previous = await readFile(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (previous?.equals(content)) continue;
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, content, { flag: 'wx' }); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}
