import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (...segments) => fs.readFileSync(path.join(root, ...segments), 'utf8');
const main = read('electron', 'main.ts');
const controller = read('electron', 'runtimeHostController.mts');
const preload = read('electron', 'preload.ts');
const composer = read('src', 'features', 'composer', 'Composer.tsx');
const chat = read('src', 'hooks', 'useCardbushChat.ts');
const builder = read('electron-builder.yml');
const packageJson = JSON.parse(read('package.json'));

const startupBlock = main.slice(main.indexOf('app.whenReady().then'), main.indexOf('function publishRuntimeStartupStatus'));
assert.ok(startupBlock.indexOf('createWindow();') < startupBlock.indexOf('void startRuntimeServices();'), 'window must be created before Runtime startup');
assert.ok(startupBlock.indexOf('createWindow();') < startupBlock.indexOf('void ensureLegacyProductSkillsMigrated();'), 'window must be created before legacy Skill migration');
assert.match(main, /phase: 'initializing' \| 'ready' \| 'error'/);
assert.match(main, /ipcMain\.handle\('app:retry-runtime'/);
assert.match(main, /stage: 'renderer-ready'/);
assert.match(main, /await ensureRuntimeServicesReady\(\)/);
assert.doesNotMatch(main, /CardBush Runtime is still initializing/);
assert.match(main, /runtimeServicesStartupTimeoutMs = 15_000/);
assert.match(main, /runtime_services_startup_timeout/);
assert.match(main, /CARDBUSH_PACKAGED_SMOKE_RESULT/);
assert.match(main, /cardbush\.packaged_smoke\.v1/);
assert.match(main, /runtime\.get_capabilities/);
assert.match(main, /shutdownClean/);
assert.match(controller, /startupTimeoutMs\?: number/);
assert.match(controller, /runtime_host_startup_timeout/);
assert.match(preload, /runtimeStartupStatus:/);
assert.match(preload, /onRuntimeStartupStatus:/);
assert.match(composer, /Runtime 正在准备/);
assert.match(composer, /retryRuntimeStartup/);
assert.match(chat, /requestContext\.runtimeReady === false/);
assert.match(builder, /asar: true/);
assert.match(builder, /dist-electron\/\*\*\/\*/);
assert.match(builder, /extraResources:/);
assert.match(builder, /assets\/runtime-tools/);
assert.match(main, /CARDBUSH_RG_PATH: bundledRipgrep/);
assert.match(main, /process\.resourcesPath/);
assert.equal(packageJson.scripts['package:win'].startsWith('npm run runtime-tools:verify'), true);
assert.equal(
  packageJson.scripts['smoke:packaged'],
  'npm run runtime-tools:verify && npm run build && electron-builder --dir --config.directories.output=release-smoke && node scripts/run-packaged-smoke.mjs',
);
assert.equal(fs.existsSync(path.join(root, 'scripts', 'run-packaged-smoke.mjs')), true);
for (const workspaceDependency of [
  '@cardbush/bush-protocol',
  '@cardbush/bush-runtime',
  '@cardbush/bush-provider-openai',
  '@cardbush/bush-runtime-electron',
  '@cardbush/product-host',
]) {
  assert.ok(
    packageJson.dependencies?.[workspaceDependency],
    `${workspaceDependency} must be packaged as a production dependency`,
  );
}

console.log('packaged startup and Runtime readiness contract passed');
