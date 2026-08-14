import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (...parts) => fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');
const preview = read('electron', 'officePreview.ts');
const main = read('electron', 'main.ts');
const inspector = read('scripts', 'inspect-office-preview.cjs');

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

console.log('office read-only preview contract tests passed');
