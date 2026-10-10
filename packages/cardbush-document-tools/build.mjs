import { cp, mkdir, readFile, utimes } from 'node:fs/promises';
await mkdir(new URL('./dist/', import.meta.url), { recursive: true });
await cp(new URL('./src/', import.meta.url), new URL('./dist/', import.meta.url), { recursive: true });
// Windows copies can retain source timestamps. Mark entry points as built so
// startup freshness checks also cover newer manifests and other workspaces.
const manifest = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
const builtAt = new Date();
await Promise.all(Object.values(manifest.exports).map(file => utimes(new URL(file, import.meta.url), builtAt, builtAt)));
