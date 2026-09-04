import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import ts from 'typescript';

const read = (...parts) => fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');
const localPaths = read('src', 'shared', 'localPaths.ts');
const messageMedia = read('src', 'features', 'messageImages.ts');
const messageBubble = read('src', 'features', 'chatMessages', 'MessageBubble.tsx');
const imagePreviewDialog = read('src', 'features', 'chatMessages', 'ImagePreviewDialog.tsx');
const chatHook = read('src', 'hooks', 'useCardbushChat.ts');
const api = read('src', 'backend', 'api.ts');
const runtimeChat = read('src', 'backend', 'runtimeChat.ts');
const productAgent = read('packages', 'bush-product-agent', 'src', 'index.ts');
const runtimeWorker = read('electron', 'runtimeHostWorker.mts');
const types = read('src', 'types.ts');
const css = read('src', 'styles', 'app.css');
const electronMain = read('electron', 'main.ts');
const electronPreload = read('electron', 'preload.ts');
const localFileProtocol = read('electron', 'localFileProtocol.ts');

assert.match(localPaths, /export function isVideoPath/);
assert.match(localPaths, /export function isAudioPath/);
assert.match(messageMedia, /export function splitMessageMedia/);
assert.match(messageMedia, /export function splitMessageMediaBlocks/);
assert.match(messageBubble, /<MessageInlineMediaContent content=\{assistantContent\}/);
assert.match(messageBubble, /<MessageMediaPath pathValue=\{pathValue\}/);
assert.match(messageBubble, /showPaths/);
assert.match(types, /type:\s*'image' \| 'video' \| 'audio' \| 'document' \| 'folder'/);
assert.match(chatHook, /isVideoPath\(pathValue\)[\s\S]*?'video'/);
assert.match(chatHook, /isAudioPath\(pathValue\)[\s\S]*?'audio'/);
assert.match(api, /toolArtifactsFromPayload\(\{ result: record\.result \}\)/);
assert.match(api, /artifacts\.length > 0 \? \{ artifacts \} : \{\}/);
assert.match(runtimeChat, /toolArtifactsFromPayload\(\{ result: record\.result \}\)/);
assert.match(runtimeChat, /images: request\.images\?\.map\(\(image\) => image\.path\)/);
assert.match(productAgent, /images: input\.images\.slice\(0, 4\)\.map\(\(url\) => \(\{ url \}\)\)/);
assert.match(runtimeWorker, /"native_image_inputs"/);
assert.doesNotMatch(api, /applyRequestCapabilityToBody/);
assert.match(messageBubble, /<video[\s\S]*?controls[\s\S]*?preload="metadata"/);
assert.match(messageBubble, /<audio[\s\S]*?controls[\s\S]*?preload="metadata"/);
assert.match(messageBubble, /readImageDataUrl\(pathValue\)/);
assert.match(messageBubble, /message-image-preview-fallback/);
assert.match(
  messageBubble,
  /<img[\s\S]*?src=\{src\}[\s\S]*?loading="lazy"[\s\S]*?decoding="async"/,
  'historical image attachments must not synchronously decode every offscreen full-resolution image',
);
assert.match(imagePreviewDialog, /event\.ctrlKey[\s\S]*?event\.metaKey/);
assert.match(imagePreviewDialog, /NumpadAdd/);
assert.match(imagePreviewDialog, /NumpadSubtract/);
assert.match(imagePreviewDialog, /Numpad0/);
assert.match(imagePreviewDialog, /onWheel=\{handleWheel\}/);
assert.match(imagePreviewDialog, /onPointerDown=\{handlePointerDown\}/);
assert.match(imagePreviewDialog, /setPointerCapture\(event\.pointerId\)/);
assert.match(imagePreviewDialog, /scrollLeft = drag\.scrollLeft -/);
assert.match(imagePreviewDialog, /scrollTop = drag\.scrollTop -/);
assert.match(imagePreviewDialog, /image-preview-zoom-controls/);
assert.match(imagePreviewDialog, /zoomRef\.current === 1 \? 2 : 1/);
assert.match(imagePreviewDialog, /import \{ createPortal \} from 'react-dom'/);
assert.match(
  imagePreviewDialog,
  /return createPortal\([\s\S]*?image-preview-backdrop[\s\S]*?document\.body/,
  'Image preview dialogs must escape message content containment and render at the application root',
);
assert.match(css, /\.message-video-player video\s*\{/);
assert.match(css, /\.message-audio-player audio\s*\{/);
assert.match(
  css,
  /\.user-bubble\s*\{[\s\S]*?max-width:\s*min\(465px, 100%\)/,
  'User bubbles must never exceed the live conversation track width',
);
assert.match(
  css,
  /\.markdown-content img\s*\{[\s\S]*?max-width:\s*100%;[\s\S]*?height:\s*auto/,
  'Markdown images must shrink with narrow message bubbles',
);
assert.match(
  css,
  /\.message-image-strip\s*\{[\s\S]*?width:\s*100%;[\s\S]*?max-width:\s*100%/,
  'Message image strips must resolve their width from the current bubble instead of intrinsic media width',
);
assert.match(css, /\.image-preview-stage\.is-dragging\s*\{[\s\S]*?cursor:\s*grabbing/);
assert.match(electronMain, /status:\s*206/);
assert.match(electronMain, /'content-range':\s*`bytes/);
assert.match(electronMain, /'accept-ranges':\s*'bytes'/);
assert.match(electronMain, /function videoMimeTypeForPath/);
assert.match(electronMain, /ipcMain\.handle\('image:read-data-url'/);
assert.match(electronMain, /function readLocalImageDataUrl/);
assert.match(electronPreload, /readImageDataUrl:/);

const localPathsModule = { exports: {} };
vm.runInNewContext(
  ts.transpileModule(localPaths, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText,
  {
    URL,
    module: localPathsModule,
    exports: localPathsModule.exports,
  },
);
const messageMediaModule = { exports: {} };
vm.runInNewContext(
  ts.transpileModule(messageMedia, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText,
  {
    module: messageMediaModule,
    exports: messageMediaModule.exports,
    require: (request) => request === '../shared/localPaths'
      ? localPathsModule.exports
      : {},
  },
);
assert.deepEqual(
  JSON.parse(JSON.stringify(messageMediaModule.exports.splitMessageMediaBlocks([
    '第一张图：',
    'C:\\renders\\one.png',
    '中间说明。',
    'C:\\renders\\two.png',
    'C:\\renders\\three.png',
    '最终说明。',
  ].join('\n')))),
  [
    { kind: 'text', content: '第一张图：' },
    { kind: 'media', items: [{ path: 'C:\\renders\\one.png', type: 'image' }] },
    { kind: 'text', content: '中间说明。' },
    {
      kind: 'media',
      items: [
        { path: 'C:\\renders\\two.png', type: 'image' },
        { path: 'C:\\renders\\three.png', type: 'image' },
      ],
    },
    { kind: 'text', content: '最终说明。' },
  ],
);

const localFileProtocolModule = { exports: {} };
vm.runInNewContext(
  ts.transpileModule(localFileProtocol, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText,
  {
    URL,
    module: localFileProtocolModule,
    exports: localFileProtocolModule.exports,
  },
);
const { localFileSystemPathFromProtocolUrl } = localFileProtocolModule.exports;
assert.equal(
  localFileSystemPathFromProtocolUrl(
    'cardbush-file:///C:/Users/wfang/Pictures/a%20b.png',
    'win32',
  ),
  'C:\\Users\\wfang\\Pictures\\a b.png',
);
assert.equal(
  localFileSystemPathFromProtocolUrl(
    'cardbush-file://c/Users/wfang/Pictures/a.png',
    'win32',
  ),
  'C:\\Users\\wfang\\Pictures\\a.png',
  'A Chromium-normalized single-letter host must remain a Windows drive',
);
assert.equal(
  localFileSystemPathFromProtocolUrl(
    'cardbush-file://server/share/a.png',
    'win32',
  ),
  '\\\\server\\share\\a.png',
  'Real UNC hosts must keep network-share semantics',
);

console.log('message media contract tests passed');
