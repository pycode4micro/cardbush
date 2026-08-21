import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (...parts) => fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');
const settings = read('src', 'features', 'SettingsView.tsx');
const css = read('src', 'styles', 'app.css');

const expectedSections = [
  'profile',
  'os',
  'runtime',
  'proxy',
  'bots',
  'subagents',
  'mcp',
  'cache',
  'models',
  'diagnostics',
  'mobile',
  'about',
].sort();
const navigationBlock = settings.match(
  /const settingsNavigationGroups[\s\S]*?const settingsIcons/,
)?.[0] ?? '';
const groupedSections = [
  ...navigationBlock.matchAll(/sections:\s*\[([^\]]+)\]/g),
].flatMap((match) => [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]));

assert.deepEqual(
  [...groupedSections].sort(),
  expectedSections,
  'Every visible settings section must appear exactly once in grouped navigation',
);
assert.match(settings, /const settingsDescriptions:/);
assert.match(settings, /className="settings-navigation"/);
assert.match(settings, /aria-current=\{section === id \? 'page' : undefined\}/);
assert.match(settings, /className="settings-page-header"/);
assert.match(settings, /className="settings-card-body"/);
assert.match(settings, /profile: \{ zh: '个性化', en: 'Personalization' \}/);
assert.match(
  settings,
  /<UsageStatisticsPanel[\s\S]*?<SettingsCard[\s\S]*?title=\{language === 'zh' \? '外观' : 'Appearance'\}/,
  'Personalization must show cumulative usage before appearance settings',
);
assert.match(settings, /className="usage-heatmap-grid"/);
assert.match(css, /\.usage-stat-grid\s*\{/);
assert.match(css, /\.usage-heatmap-grid\s*\{/);
assert.match(
  css,
  /\.personalization-settings-stack\s*\{[\s\S]*?container-type:\s*inline-size/,
  'Personalization layout must respond to its actual content width.',
);
assert.match(
  css,
  /--usage-heatmap-cell-size:\s*clamp\(7px,\s*1\.45cqi,\s*16px\)/,
  'The usage heatmap must scale with the settings card instead of using fixed cells.',
);
assert.match(
  css,
  /@container personalization-settings \(max-width:\s*680px\)[\s\S]*?\.usage-stat-grid[\s\S]*?repeat\(2,/,
  'Usage statistics must reflow when the settings content is narrow.',
);
assert.match(css, /\.settings-card-body\s*\{/);
assert.match(css, /\.settings-radio:has\(input:checked\)/);
assert.match(css, /\.settings-switch input:checked::after/);
assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.settings-actions > button/);

console.log('settings layout contract tests passed');
