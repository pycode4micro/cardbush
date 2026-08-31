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
assert.match(types, /type:\s*'image' \| 'video' \| 'audio' \| 'document' \| 'folder'/);
assert.match(chatHook, /isVideoPath\(pathValue\)[\s\S]*?'video'/);
assert.match(chatHook, /isAudioPath\(pathValue\)[\s\S]*?'audio'/);
assert.match(api, /toolArtifactsFromPayload\(\{[\s\S]*?record\.result\.artifacts/);
assert.match(api, /artifacts\.length > 0 \? \{ artifacts \} : \{\}/);
assert.match(runtimeChat, /record\.result\.artifacts\.map\(artifact\)/);
assert.match(runtimeChat, /images: request\.images\?\.map\(\(image\) => image\.path\)/);
assert.match(productAgent, /images: input\.images\.slice\(0, 4\)\.map\(\(url\) => \(\{ url \}\)\)/);
assert.match(runtimeWorker, /"native_image_inputs"/);
assert.doesNotMatch(api, /applyRequestCapabilityToBody/);
assert.match(messageBubble, /<video[\s\S]*?controls[\s\S]*?preload="metadata"/);
assert.match(messageBubble, /<audio[\s\S]*?controls[\s\S]*?preload="metadata"/);
assert.match(messageBubble, /readImageDataUrl\(pathValue\)/);
assert.match(messageBubble, /message-image-preview-fallback/);
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
assert.match(css, /\.message-video-player video\s*\{/);
assert.match(css, /\.message-audio-player audio\s*\{/);
assert.match(css, /\.image-preview-stage\.is-dragging\s*\{[\s\S]*?cursor:\s*grabbing/);
assert.match(electronMain, /status:\s*206/);
assert.match(electronMain, /'content-range':\s*`bytes/);
assert.match(electronMain, /'accept-ranges':\s*'bytes'/);
assert.match(electronMain, /function videoMimeTypeForPath/);
assert.match(electronMain, /ipcMain\.handle\('image:read-data-url'/);
assert.match(electronMain, /function readLocalImageDataUrl/);
assert.match(electronPreload, /readImageDataUrl:/);

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
