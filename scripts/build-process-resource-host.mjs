import path from 'node:path';
import { buildProcessResourceHost } from './lib/process-host-build.mjs';

try {
  buildProcessResourceHost({
    root: path.resolve(import.meta.dirname, '..'),
    // Only the development GUI opts in. Ordinary builds and release gates remain strict.
    allowUnavailable: process.argv.includes('--allow-unavailable')
      || process.env.CARDBUSH_DEVELOPMENT_BUILD === '1',
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
