import { fileURLToPath } from 'node:url';
import { precompileComputerUseNativeCode } from '../dist/plugins/computerUseRuntime.js';

// Windows releases carry immutable native libraries. A package produced on a
// different host can compile them once on first use; neither path starts a daemon.
if (process.platform === 'win32') {
  await precompileComputerUseNativeCode(fileURLToPath(new URL('../dist/native/', import.meta.url)));
  console.log('Computer Use native libraries ready (on-demand execution).');
}
