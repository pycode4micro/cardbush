import { createRequire } from 'node:module';
import { launchElectronFixture } from './helpers/electron-test-lifecycle.cjs';

const require = createRequire(import.meta.url);
const env = { ...process.env };
if (process.argv[2]) env.CARDBUSH_APP_VIEWS_CASE = process.argv[2];
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
process.exitCode = await launchElectronFixture(require('electron'), ['scripts/test-app-views.cjs'], env);
