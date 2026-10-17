import { build } from 'vite';
import { fileURLToPath } from 'node:url';

await build({
  root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, publicDir: false,
  ssr: { noExternal: true },
  build: { ssr: 'assets/plugins/agentchatroom/src/index.ts', target: 'node24',
    outDir: 'assets/plugins/agentchatroom/runtime', emptyOutDir: false, minify: false,
    rolldownOptions: { output: { entryFileNames: 'index.mjs', codeSplitting: false } } },
});
