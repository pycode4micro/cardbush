import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (...parts) => fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');
const app = read('src', 'App.tsx');
const types = read('src', 'types.ts');
const settings = read('src', 'features', 'SettingsView.tsx');
const navigation = read('src', 'features', 'settings', 'settingsNavigation.ts');
const controls = read('src', 'features', 'settings', 'SettingsControls.tsx');
const profilePanel = read('src', 'features', 'settings', 'SettingsPersonalizationPanel.tsx');
const appearancePanel = read('src', 'features', 'settings', 'SettingsAppearancePanel.tsx');
const usagePanel = read('src', 'features', 'settings', 'UsageStatisticsPanel.tsx');
const css = read('src', 'styles', 'app.css');
const importedTheme = read('src', 'features', 'appearance', 'importedThemeStyle.ts');
const electronMain = read('electron', 'main.ts');
const preload = read('electron', 'preload.ts');
const electronTypes = read('src', 'types', 'electron.d.ts');
const startup = read('index.html');
const sidebarResizer = read('src', 'components', 'SidebarResizer.tsx');

const expectedSections = [
  'profile',
  'appearance',
  'usage',
  'runtime',
  'proxy',
  'mcp',
  'cache',
  'models',
  'diagnostics',
].sort();
const navigationBlock = navigation.match(
  /const settingsNavigationGroups[\s\S]*?const keywords/,
)?.[0] ?? '';
const groupedSections = [
  ...navigationBlock.matchAll(/sections:\s*\[([^\]]+)\]/g),
].flatMap((match) => [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]));

assert.deepEqual(
  [...groupedSections].sort(),
  expectedSections,
  'Every visible settings section must appear exactly once in grouped navigation',
);
assert.doesNotMatch(
  navigationBlock,
  /['"]os['"]|CardBush OS|操作系统模式|OS mode/i,
  'Removed OS mode must not return to settings navigation',
);
assert.doesNotMatch(
  settings,
  /SubagentsPanel|子任务运行态|Task runtime/,
  'The provisional Subagent runtime settings UI must remain hidden',
);
assert.match(navigation, /const settingsDescriptions:/);
assert.match(settings, /className="settings-navigation"/);
assert.match(settings, /aria-current=\{section === id \? 'page' : undefined\}/);
assert.match(settings, /className="settings-page-header"/);
assert.match(controls, /className="settings-card-body"/);
assert.doesNotMatch(settings, /settings\.thinking\.accentColor|思考颜色|Thinking color/);
assert.doesNotMatch(app, /defaultThinkingAccentColor|cardbush_thinking_accent_color'\s*,\s*normalizeHexColor/);
assert.match(profilePanel, /name="guidance-delivery-mode"/);
assert.match(profilePanel, /'加入队列' : 'Add to queue'/);
assert.match(profilePanel, /'马上发送' : 'Send immediately'/);
assert.match(app, /cardbush_guidance_delivery_mode/);
assert.match(app, /settings\.guidance\?\.deliveryMode === 'immediate'/);
assert.match(navigation, /profile: \{ zh: '个性化', en: 'Personalization' \}/);
assert.match(settings, /profile: SlidersHorizontal/);
const runtimePanel = settings.match(
  /if \(section === 'runtime'\)[\s\S]*?if \(section === 'proxy'\)/,
)?.[0] ?? '';
assert.match(profilePanel, /name="guidance-delivery-mode"/);
assert.doesNotMatch(runtimePanel, /name="guidance-delivery-mode"/);
assert.match(profilePanel, /<ConversationStyleSettings/);
assert.match(profilePanel, /<GlobalInstructionsPanel/);
assert.doesNotMatch(profilePanel, /UsageStatisticsPanel|theme-mode|language-mode/);
assert.match(appearancePanel, /name="theme-mode"/);
assert.doesNotMatch(appearancePanel, /parchment|羊皮纸|Parchment/);
assert.match(appearancePanel, /onThemePreferenceChange\(value as ThemePreference\)/);
assert.match(types, /ThemePreference[\s\S]*?'light'[\s\S]*?'custom'/);
assert.match(app, /preference === 'light'[\s\S]*?return 'bright'/);
assert.doesNotMatch(app, /return 'parchment'/);
assert.doesNotMatch(appearancePanel, /name="light-style"|浅色外观|Light appearance/);
assert.doesNotMatch(
  settings,
  /背景图片|Background image|pickBackgroundImage|shadow-color-setting|Shadow 消息|Accent color/,
);
assert.match(settings, /pickAppearanceStyle/);
assert.match(settings, /parseImportedThemeStyle/);
assert.match(importedTheme, /cardbush\.appearance_style\.v1/);
assert.match(importedTheme, /unknown_color/);
assert.match(preload, /dialog:pick-appearance-style/);
assert.match(electronMain, /dialog:pick-appearance-style/);
assert.match(electronTypes, /pickAppearanceStyle/);
assert.doesNotMatch(preload, /pickBackgroundImage|cacheBackgroundImage/);
assert.doesNotMatch(electronMain, /dialog:pick-background-image|cacheBackgroundImage/);
assert.doesNotMatch(app, /backgroundImagePath|has-custom-background|appSettings\.shadow/);
assert.doesNotMatch(startup, /cardbush_background_image_path|data-start-custom-background/);
assert.match(
  settings,
  /if \(section === 'usage'\)[\s\S]*?<UsageStatisticsPanel/,
  'Usage statistics must have a dedicated page',
);
assert.match(usagePanel, /className="usage-heatmap-grid"/);
assert.match(usagePanel, /UsageHeatmapRange = 'year' \| 'month' \| 'week'/);
assert.match(usagePanel, /className="usage-range-switcher"/);
assert.doesNotMatch(usagePanel, /className="usage-legend"|SettingsCard/);
assert.match(css, /\.usage-stat-grid\s*\{/);
assert.match(css, /\.usage-heatmap-grid\s*\{/);
assert.match(
  css,
  /\.usage-settings\s*\{[\s\S]*?container-type:\s*inline-size/,
  'Usage layout must respond to its actual content width.',
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
  /@container usage-settings \(max-width:\s*680px\)[\s\S]*?\.usage-stat-grid[\s\S]*?repeat\(2,/,
  'Usage statistics must reflow when the settings content is narrow.',
);
assert.match(css, /\.settings-card-body\s*\{/);
assert.match(settings, /const \[addModelExpanded, setAddModelExpanded\] = useState\(false\)/);
assert.match(settings, /bodyHidden=\{!addModelExpanded\}/);
assert.match(settings, /aria-expanded=\{addModelExpanded\}/);
assert.match(settings, /const confirmResetModels = useCallback\(\(\) => \{/);
assert.match(settings, /const confirmed = window\.confirm\([\s\S]*?if \(confirmed\) onResetModels\(\)/);
assert.match(settings, /className="secondary-button danger model-clear-all-button"[\s\S]*?onClick=\{confirmResetModels\}/);
assert.match(controls, /bodyHidden\?: boolean/);
assert.match(controls, /!bodyHidden && <div className="settings-card-body">/);
assert.match(css, /\.model-settings-stack\s*\{[\s\S]*?container-name:\s*model-settings/);
assert.match(css, /@container model-settings \(max-width:\s*720px\)[\s\S]*?\.model-row[\s\S]*?repeat\(2,/);
assert.match(
  css,
  /\.model-row > div > strong\s*\{[\s\S]*?overflow:\s*hidden;[\s\S]*?text-overflow:\s*ellipsis/,
  'Long model names must stay inside their responsive summary column.',
);
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
  /\.app > \.settings-shell\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?inset:\s*var\(--window-frame-height\) 0 0;[\s\S]*?z-index:\s*100;/,
  'Settings must cover the preserved app shell below the native title bar.',
);
assert.match(
  css,
  /\.desktop-shell\.app-content-suspended\s*\{[\s\S]*?opacity:\s*0\.001;[\s\S]*?pointer-events:\s*none;/,
  'The preserved app shell must keep its composited paint layer without remaining interactive.',
);
assert.match(css, /\.settings-shell\.settings-inactive\s*\{[\s\S]*?visibility:\s*hidden/);
assert.match(
  settings,
  /sidebar settings-sidebar soft-panel-motion/,
  'Settings must reuse the main sidebar motion and layout styles.',
);
assert.match(app, /<LazySettingsView[\s\S]*?sidebarPresence=\{sidebarPresence\}[\s\S]*?sidebarWidth=\{sidebarWidth\}[\s\S]*?onSidebarCollapse=\{collapseSidebar\}/);
assert.match(settings, /<SidebarResizer[\s\S]*?onCollapse=\{onSidebarCollapse\}/);
assert.match(sidebarResizer, /const minimumSidebarWidth = 220/);
assert.match(
  sidebarResizer,
  /clampPreviewWidth\([\s\S]*?Boolean\(onCollapse\)[\s\S]*?canCollapse \? 0 : minimumSidebarWidth/,
  'A collapsible sidebar may cross the readable minimum to trigger collapse.',
);
assert.match(
  sidebarResizer,
  /readCurrentSidebarWidth\(event\.currentTarget\)[\s\S]*?previousElementSibling[\s\S]*?getBoundingClientRect\(\)\.width/,
  'Sidebar resizing must begin from rendered geometry instead of a stale CSS preview value.',
);
console.log('settings layout contract tests passed');
