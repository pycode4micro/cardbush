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
assert.match(css, /\.settings-card-body\s*\{/);
assert.match(css, /\.settings-radio:has\(input:checked\)/);
assert.match(css, /\.settings-switch input:checked::after/);
assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.settings-actions > button/);

console.log('settings layout contract tests passed');
