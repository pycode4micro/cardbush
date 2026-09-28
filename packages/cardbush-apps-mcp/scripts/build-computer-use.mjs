import { fileURLToPath } from 'node:url';
import { precompileComputerUseNativeCode } from '../dist/plugins/computerUseRuntime.js';
import { prepareComputerUsePresentation } from '../dist/plugins/computerUsePresentation.js';

// Build Windows releases on Windows so every native library, including the
// control overlay, is available for signing before it reaches a user device.
if (process.platform === 'win32') {
  await precompileComputerUseNativeCode(fileURLToPath(new URL('../dist/native/', import.meta.url)));
  await prepareComputerUsePresentation(fileURLToPath(new URL('../dist/native/', import.meta.url)));
  console.log('Computer Use native libraries ready (on-demand execution).');
}
