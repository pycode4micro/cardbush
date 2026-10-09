import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import { installLocalProductPlugin } from '../../dist-electron/localPluginInstall.js';

// Test the native plugin contract without depending on a product feature package.
export async function installRuntimePluginFixture(directory, installed) {
  const zip = new JSZip();
  zip.file('fixture-runtime/.codex-plugin/plugin.json', JSON.stringify({
    name: 'fixture-runtime', version: '1.0.0', cardbush: {
      runtimeExtension: { apiVersion: 1, entry: './dist/runtime.mjs', renderer: './dist/renderer.mjs' },
    },
  }));
  for (const name of ['runtime', 'renderer']) {
    zip.file(`fixture-runtime/dist/${name}.mjs`, await readFile(new URL(`./runtime-plugin/${name}.mjs`, import.meta.url), 'utf8'));
  }
  const archive = join(directory, 'fixture-runtime.zip');
  await writeFile(archive, await zip.generateAsync({ type: 'nodebuffer' }));
  await installLocalProductPlugin(archive, installed);
}
