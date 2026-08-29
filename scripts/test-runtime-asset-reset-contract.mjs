import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (...parts) => fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');

const api = read('src', 'backend', 'api.ts');
const app = read('src', 'App.tsx');
const settings = read('src', 'features', 'SettingsView.tsx');
const styles = read('src', 'styles', 'app.css');

assert.match(api, /maintenanceRuntimeAssetsReset:\s*true/);
assert.match(api, /runtimeAssetResetProtocol:\s*RUNTIME_ASSET_RESET_PROTOCOL/);
assert.match(api, /runtimeAssetResetCategories:\s*\['prompts', 'skills', 'agent_profiles', 'teams'\]/);
assert.match(api, /productHostValue\(\{ kind: 'maintenance\.runtime_assets\.plan' \}\)/);
assert.match(api, /kind: 'maintenance\.runtime_assets\.reset'/);
assert.match(api, /categories:\s*selected,[\s\S]*?confirm: true/);
assert.match(api, /restartRequired: payload\.restart_required === true/);
assert.match(api, /productHostValue\(\{ kind: 'maintenance\.diagnostics' \}\)/);

assert.match(settings, /runtimeAssetCategoryOrder[\s\S]*?'prompts'[\s\S]*?'skills'/);
assert.match(settings, /runtimeAssetCategoryOrder[\s\S]*?'agent_profiles'[\s\S]*?'teams'/);
assert.match(api, /resetProductTeamConfiguration/);
assert.doesNotMatch(settings, /tools:\s*\{ zh: 'Tools'/);
assert.match(settings, /type="checkbox"/);
assert.match(settings, /window\.confirm/);
assert.match(settings, /runtime_asset_reset_requires_idle_runtime/);
assert.match(settings, /必须重启 CardBush/);
assert.match(settings, /我已重启，验证并加载/);
assert.match(settings, /restoredFileCount/);
assert.match(settings, /removedRuntimeFileCount/);
assert.match(settings, /fetchSubagentRuntime/);
assert.match(settings, /查看服务日志/);
assert.match(settings, /cardbush_pending_runtime_asset_reset/);
assert.match(settings, /persistPendingRuntimeAssetReset\(next\.restartRequired \? next : null\)/);

assert.match(app, /fetchBackendReadiness/);
assert.match(app, /fetchBackendCapabilities\(\)/);
assert.match(app, /fetchSkills\(\)/);
assert.match(app, /persistDisabledSkillNames/);
assert.doesNotMatch(app, /persistDisabledToolNames|cardbush_disabled_tools/);
assert.match(styles, /\.runtime-asset-restart-required\s*\{/);

console.log('runtime asset reset contract tests passed');
