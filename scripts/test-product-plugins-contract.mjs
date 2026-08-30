import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import {
  installProductPlugin,
  loadProductPluginCatalog,
} from '../dist-electron/productPlugins.js';

const bundledRoot = resolve('assets', 'plugins');
const catalog = await loadProductPluginCatalog([{ path: bundledRoot, source: 'bundled' }]);
assert.deepEqual(catalog.map((plugin) => plugin.id), [
  'computer-use',
  'cardbush-bot',
  'chrome',
  'browser-ops',
]);
for (const plugin of catalog) {
  assert.match(plugin.manifestPath, /\.codex-plugin[\\/]plugin\.json$/);
  assert.ok(plugin.logoPath.endsWith('.svg'));
  assert.ok(plugin.name);
  assert.ok(plugin.version);
}
assert.deepEqual(catalog.find((plugin) => plugin.id === 'computer-use')?.components.map((item) => item.kind), ['mcp']);
assert.deepEqual(catalog.find((plugin) => plugin.id === 'cardbush-bot')?.components.map((item) => item.kind), ['app']);
assert.deepEqual(
  catalog.find((plugin) => plugin.id === 'chrome')?.components.map((item) => item.kind),
  ['mcp', 'app'],
);
const chromePackage = JSON.parse(readFileSync(resolve(
  'assets', 'plugins', 'chrome', 'runtime', 'chrome-devtools-mcp', 'package.json',
), 'utf8'));
assert.equal(chromePackage.name, 'chrome-devtools-mcp');
assert.equal(chromePackage.version, '1.8.0');
assert.equal(chromePackage.author, 'Google LLC');
assert.equal(chromePackage.license, 'Apache-2.0');
assert.ok(readFileSync(resolve('assets', 'plugins', 'chrome', '.mcp.json'), 'utf8').includes('chrome-devtools-mcp.js'));
const chromeVendorMetadata = JSON.parse(readFileSync(resolve(
  'assets', 'plugins', 'chrome', 'vendor', 'OFFICIAL_PACKAGE.json',
), 'utf8'));
const chromeTarball = readFileSync(resolve(
  'assets', 'plugins', 'chrome', 'vendor', 'chrome-devtools-mcp-1.8.0.tgz',
));
assert.equal(
  `sha512-${createHash('sha512').update(chromeTarball).digest('base64')}`,
  chromeVendorMetadata.integrity,
);

const temporary = await mkdtemp(join(tmpdir(), 'cardbush-plugin-install-'));
try {
  const installed = await installProductPlugin(join(bundledRoot, 'chrome'), temporary);
  assert.equal(installed.id, 'chrome');
  const userCatalog = await loadProductPluginCatalog([{ path: temporary, source: 'user' }]);
  assert.deepEqual(userCatalog.map((plugin) => plugin.id), ['chrome']);
  assert.equal(userCatalog[0].installation, 'INSTALLED_BY_DEFAULT');
} finally {
  await rm(temporary, { recursive: true, force: true });
}

console.log('CardBush Codex-compatible plugin manifest and catalog contract passed');

const managementSource = readFileSync(resolve('src', 'features', 'plugins', 'PluginManagementPanel.tsx'), 'utf8');
assert.match(managementSource, /type ManageTab = 'plugins' \| 'apps' \| 'mcp'/);
assert.match(managementSource, /document\.addEventListener\('pointerdown', closeFromOutside, true\)/);
assert.match(managementSource, /activeTab === 'apps'/);
assert.match(managementSource, /activeTab === 'mcp'/);
assert.match(managementSource, /返回插件/);
assert.match(managementSource, /scope === 'public' \? plugin\.source === 'bundled' : plugin\.source === 'user'/);
assert.match(managementSource, /setScope\('personal'\)/);
assert.doesNotMatch(managementSource, /'插件' : 'Plugins'\}<ChevronRight[^>]*\/>\{plugin\.name\}/);

const managementStyles = readFileSync(resolve('src', 'features', 'plugins', 'plugin-management.css'), 'utf8');
assert.match(managementStyles, /\.plugin-installed-icons button:hover > span:not\(\.plugin-logo\)/);
assert.match(managementStyles, /opacity: 0/);
