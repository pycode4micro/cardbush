import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (...parts) => fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');
const app = read('src', 'App.tsx');
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
assert.match(settings, /UsageHeatmapRange = 'year' \| 'month' \| 'week'/);
assert.match(settings, /className="usage-range-switcher"/);
assert.doesNotMatch(settings, /className="usage-legend"/);
assert.match(css, /\.usage-stat-grid\s*\{/);
assert.match(css, /\.usage-heatmap-grid\s*\{/);
assert.match(
  css,
  /\.personalization-settings-stack\s*\{[\s\S]*?container-type:\s*inline-size/,
  'Personalization layout must respond to its actual content width.',
);
assert.match(
  css,
  /grid-template-columns:\s*repeat\(var\(--usage-heatmap-columns\),\s*minmax\(0,\s*1fr\)\)/,
  'The usage heatmap must fit its selected date range into the settings card.',
);
assert.match(css, /\.usage-heatmap-scroll\s*\{[\s\S]*?overflow:\s*hidden/);
assert.doesNotMatch(css, /\.usage-heatmap-scroll\s*\{[\s\S]*?overflow-x:\s*auto/);
assert.match(
  css,
  /@container personalization-settings \(max-width:\s*680px\)[\s\S]*?\.usage-stat-grid[\s\S]*?repeat\(2,/,
  'Usage statistics must reflow when the settings content is narrow.',
);
assert.match(css, /\.settings-card-body\s*\{/);
assert.match(css, /\.settings-radio:has\(input:checked\)/);
assert.match(css, /\.settings-switch input:checked::after/);
assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.settings-actions > button/);
assert.match(
  app,
  /\{settingsMounted && \([\s\S]*?<LazySettingsView[\s\S]*?active=\{settingsVisible\}[\s\S]*?<main[\s\S]*?app-content-suspended/,
  'Opening settings must keep the app shell mounted so chat geometry and scroll state survive the return.',
);
assert.match(app, /setSettingsMounted\(true\);[\s\S]*?setSettingsOpen\(true\);/);
assert.match(app, /const settingsVisible = settingsOpen && settingsReady/);
assert.match(app, /<Suspense fallback=\{null\}>/);
assert.match(app, /void loadSettingsViewModule\(\)/);
assert.match(settings, /useLayoutEffect\(\(\) => \{[\s\S]*?onReady\(\)/);
assert.match(settings, /settings-inactive/);
assert.match(settings, /inert=\{active \? undefined : true\}/);
assert.match(app, /aria-hidden=\{settingsVisible\}/);
assert.match(app, /inert=\{settingsVisible \? true : undefined\}/);
assert.match(
  css,
  /\.app > \.settings-shell\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?inset:\s*29px 0 0;[\s\S]*?z-index:\s*100;/,
  'Settings must cover the preserved app shell below the native title bar.',
);
assert.match(
  css,
  /\.desktop-shell\.app-content-suspended\s*\{[\s\S]*?opacity:\s*0\.001;[\s\S]*?pointer-events:\s*none;/,
  'The preserved app shell must keep its composited paint layer without remaining interactive.',
);
assert.match(css, /\.settings-shell\.settings-inactive\s*\{[\s\S]*?visibility:\s*hidden/);
assert.match(
  css,
  /\.app\.has-custom-background > \.settings-shell\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?z-index:\s*100;/,
  'Custom backgrounds must not demote the settings overlay back into document flow.',
);

console.log('settings layout contract tests passed');
