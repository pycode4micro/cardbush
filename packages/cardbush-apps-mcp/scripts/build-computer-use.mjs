import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readdir, rename, rm, access } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { precompileComputerUseNativeCode } from '../dist/plugins/computerUseRuntime.js';
import { prepareComputerUsePresentation } from '../dist/plugins/computerUsePresentation.js';

// Build Windows releases on Windows so every native library, including the
// control overlay, is available for signing before it reaches a user device.
if (process.platform === 'win32') {
  const directory = fileURLToPath(new URL('../dist/native/', import.meta.url));
  await mkdir(directory, { recursive: true });
  const staging = await mkdtemp(join(directory, 'build-'));
  try {
    await precompileComputerUseNativeCode(staging);
    await prepareComputerUsePresentation(staging);
    const current = new Set(await readdir(staging));
    for (const name of current) {
      const target = join(directory, name);
      if (!await access(target).then(() => true, () => false)) await rename(join(staging, name), target);
    }
    // Only compiler-owned hash artifacts are retired. No user cache or source
    // files are touched, and pruning starts only after the new build succeeds.
    for (const name of await readdir(directory)) {
      if (/^CardBush-(?:Desktop-)?[a-f0-9]{64}\.(dll|exe)$/.test(name) && !current.has(name)) await rm(join(directory, name));
    }
  } finally {
    if (!resolve(staging).startsWith(resolve(directory) + sep + 'build-')) throw new Error('Invalid native staging directory.');
    await rm(staging, { recursive: true, force: true });
  }
  console.log('Computer Use native libraries ready (on-demand execution).');
}
