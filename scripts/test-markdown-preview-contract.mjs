import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (...parts) => fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');
const app = read('src', 'App.tsx');
const styles = read('src', 'styles', 'app.css');
const main = read('electron', 'main.ts');
const preload = read('electron', 'preload.ts');
const desktopTypes = read('src', 'types', 'electron.d.ts');
const messageBubble = read('src', 'features', 'chatMessages', 'MessageBubble.tsx');

assert.match(app, /function isMarkdownInspectorTarget/);
assert.ok(app.includes("/\\.(?:md|markdown)$/i"));
assert.match(app, /<MarkdownInspectorPreview/);
assert.match(app, /<MarkdownContent content=\{content\} language=\{language\}/);
assert.match(app, /MessageFileReferenceScope workspaceRoot=\{parentDirectory\(path\)\}/);
assert.match(app, /setMarkdownRevision\(\(value\) => value \+ 1\)/);
assert.match(main, /ipcMain\.handle\('shell:read-text-preview'/);
assert.match(main, /const maxPreviewBytes = 2 \* 1024 \* 1024/);
assert.match(main, /Preview target is not a text file/);
assert.match(preload, /readTextPreview: \(targetPath: string\)/);
assert.match(desktopTypes, /readTextPreview: \(targetPath: string\)/);
assert.match(styles, /\.markdown-inspector-document/);
assert.match(styles, /\.markdown-inspector-document \.markdown-content img/);
assert.match(messageBubble, /function explicitMarkdownLocalReference/);
assert.match(messageBubble, /src=\{resolvedSource\}/);

console.log('markdown inspector preview contract tests passed');
