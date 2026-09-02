import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (...parts) => fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');
const preview = read('electron', 'officePreview.ts');
const main = read('electron', 'main.ts');
const inspector = read('scripts', 'inspect-office-preview.cjs');
const previewEntry = read('src', 'officePreviewMain.ts');
const previewHtml = read('office-preview.html');
const viteConfig = read('vite.config.mts');
const packageJson = JSON.parse(read('package.json'));

assert.match(preview, /const officePreviewExtensions = new Set/);
assert.match(preview, /'\.doc'/);
assert.match(preview, /'\.xls'/);
assert.match(preview, /'\.ppt'/);
assert.match(preview, /officeReaderToolbarMarkup/);
assert.match(preview, /role="toolbar" aria-label="只读阅读工具"/);
assert.match(preview, /class="readonly-badge">只读预览/);
assert.match(preview, /aria-label="[^"\n]*只读内容"/);
assert.match(preview, /data-action="zoom-in"/);
assert.match(preview, /data-action="fit"/);
assert.match(preview, /data-action="previous-slide"/);
assert.match(preview, /data-sheet-index/);
assert.match(preview, /event\.key === 'PageDown'/);
assert.match(preview, /event\.key === '0'/);
assert.doesNotMatch(preview, /data-ribbon-(?:tab|panel)/);
assert.doesNotMatch(preview, /class="office-(?:ribbon|commandbar)"/);
assert.doesNotMatch(preview, /contenteditable/i);
assert.doesNotMatch(preview, /fs\.promises\.(?:writeFile|rename|unlink|rm)/);
assert.match(main, /officeReadOnlyPreview/);
assert.match(main, /autoHideMenuBar: officeReadOnlyPreview/);
assert.match(main, /!officeReadOnlyPreview[\s\S]*?在系统中打开/);
assert.match(main, /protocolHost === 'office-source'/);
assert.match(main, /isHighFidelityOfficePreviewPath/);
assert.match(main, /officePreviewRendererEntryResponse/);
assert.match(main, /parsed\.searchParams\.get\('renderer'\) !== 'compat'/);
assert.match(main, /relativeToRoot\.startsWith\('\.\.'\)/);
assert.match(main, /application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/);
assert.match(main, /application\/vnd\.openxmlformats-officedocument\.presentationml\.presentation/);
assert.match(main, /application\/vnd\.ms-powerpoint/);

assert.match(viteConfig, /base: '\.\/'/);
assert.match(viteConfig, /officePreview: path\.resolve\(rootDir, 'office-preview\.html'\)/);
assert.match(previewHtml, /Content-Security-Policy/);
assert.match(previewHtml, /script-src 'self' 'wasm-unsafe-eval'/);
assert.doesNotMatch(previewHtml, /script-src[^;]*'unsafe-eval'/);
assert.match(previewHtml, /connect-src 'self' cardbush-file:/);
assert.match(previewHtml, /src="\/src\/officePreviewMain\.ts"/);
assert.match(previewEntry, /import\('@file-viewer\/renderer-spreadsheet'\)/);
assert.match(previewEntry, /import\('@file-viewer\/renderer-pptx'\)/);
assert.match(previewEntry, /import\('@file-viewer\/renderer-ppt'\)/);
assert.match(previewEntry, /cardbush-file:\/\/office-source\//);
assert.match(previewEntry, /spreadsheetWorkerUrl/);
assert.match(previewEntry, /ppt-native\.wasm\?url/);
assert.match(previewEntry, /ppt-font-cjk\.otf\?url/);
assert.match(previewEntry, /ppt\/worker\.mjs\?url/);
assert.match(previewEntry, /resizableColumns: true/);
assert.match(previewEntry, /resizableRows: true/);
assert.match(previewEntry, /url\.searchParams\.set\('renderer', 'compat'\)/);
assert.doesNotMatch(previewEntry, /https?:\/\//);
assert.equal(packageJson.dependencies['@file-viewer/core'], '3.0.0');
assert.equal(packageJson.dependencies['@file-viewer/ppt'], '0.3.3');
assert.equal(packageJson.dependencies['@file-viewer/renderer-ppt'], '3.0.0');
assert.equal(packageJson.dependencies['@file-viewer/renderer-spreadsheet'], '3.0.0');
assert.equal(packageJson.dependencies['@file-viewer/renderer-pptx'], '3.0.0');

const toolbarMarkup = preview.match(/function officeReaderToolbarMarkup[\s\S]*?function officeInteractionScript/)?.[0] ?? '';
const actions = [...toolbarMarkup.matchAll(/data-action="([^"]+)"/g)].map((match) => match[1]);
assert.deepEqual(
  [...new Set(actions)].sort(),
  [
    'fit',
    'next-slide',
    'previous-slide',
    'toggle-formula',
    'toggle-gridlines',
    'zoom-in',
    'zoom-out',
    'zoom-reset',
  ],
);

assert.match(inspector, /hasReaderToolbar/);
assert.match(inspector, /mutatingControlCount/);
assert.match(inspector, /hasSpreadsheetRoot/);
assert.match(inspector, /sheetTabs/);
assert.match(inspector, /reading-sample\.pptx/);
assert.match(inspector, /CardBush 完整幻灯片预览/);

console.log('office full-fidelity read-only preview contract tests passed');
