import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (...parts) => fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');

const api = read('src', 'backend', 'api.ts');
const app = read('src', 'App.tsx');
const settings = read('src', 'features', 'SettingsView.tsx');
const styles = read('src', 'styles', 'app.css');

const mergedHeaders = new Headers({ 'content-type': 'application/json' });
new Headers({ 'Content-Type': 'application/json' }).forEach((value, key) => {
  mergedHeaders.set(key, value);
});
assert.equal(mergedHeaders.get('content-type'), 'application/json');

assert.match(api, /maintenance_runtime_assets_reset/);
assert.match(api, /root\.runtime_asset_reset/);
assert.match(api, /\/v1\/maintenance\/runtime-assets'/);
assert.match(api, /\/v1\/maintenance\/runtime-assets\/reset'/);
assert.match(api, /JSON\.stringify\(\{ categories, confirm: true \}\)/);
assert.match(api, /new Headers\(await headersFor\(input, init\?\.body != null\)\)/);
assert.match(api, /headers\.set\(key, value\)/);
assert.match(api, /restartRequired: payload\.restart_required === true/);
assert.match(api, /\/v1\/chain\/logs\?limit=50/);
assert.match(api, /\/v1\/tools\/failures\?limit=50/);

assert.match(settings, /runtimeAssetCategoryOrder[\s\S]*?'prompts'[\s\S]*?'skills'[\s\S]*?'tools'/);
assert.match(settings, /type="checkbox"/);
assert.match(settings, /window\.confirm/);
assert.match(settings, /runtime_asset_reset_requires_idle_runtime/);
assert.match(settings, /必须重启 BushServer/);
assert.match(settings, /我已重启，验证并加载/);
assert.match(settings, /restoredFileCount/);
assert.match(settings, /removedRuntimeFileCount/);
assert.match(settings, /fetchSubagentRuntime/);
assert.match(settings, /查看服务日志/);
assert.match(settings, /cardbush_pending_runtime_asset_reset/);
assert.match(settings, /persistPendingRuntimeAssetReset\(next\.restartRequired \? next : null\)/);

assert.match(app, /fetchBackendReadiness/);
assert.match(app, /fetchBackendCapabilities\(\)/);
assert.match(app, /fetchRuntimeToolInventory\(\)/);
assert.match(app, /fetchSkills\(\)/);
assert.match(app, /persistDisabledSkillNames/);
assert.match(app, /persistDisabledToolNames/);
assert.match(styles, /\.runtime-asset-restart-required\s*\{/);

console.log('runtime asset reset contract tests passed');
