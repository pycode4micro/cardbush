import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import ts from 'typescript';

const read = (...parts) => fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');
const localPaths = read('src', 'shared', 'localPaths.ts');
const messageMedia = read('src', 'features', 'messageImages.ts');
const messageBubble = read('src', 'features', 'chatMessages', 'MessageBubble.tsx');
const chatHook = read('src', 'hooks', 'useCardbushChat.ts');
const api = read('src', 'backend', 'api.ts');
const types = read('src', 'types.ts');
const css = read('src', 'styles', 'app.css');
const electronMain = read('electron', 'main.ts');
const electronPreload = read('electron', 'preload.ts');
const localFileProtocol = read('electron', 'localFileProtocol.ts');

assert.match(localPaths, /export function isVideoPath/);
assert.match(localPaths, /export function isAudioPath/);
assert.match(messageMedia, /export function splitMessageMedia/);
assert.match(types, /type:\s*'image' \| 'video' \| 'audio' \| 'document'/);
assert.match(chatHook, /isVideoPath\(pathValue\)[\s\S]*?'video'/);
assert.match(chatHook, /isAudioPath\(pathValue\)[\s\S]*?'audio'/);
assert.match(api, /function messageAttachmentsFromPayload/);
assert.match(api, /function structuredImageSources/);
assert.match(api, /attachments:\s*attachments\.length > 0 \? attachments : undefined/);
assert.match(api, /applyRequestCapabilityToBody\(body, 'vision', true\)/);
assert.match(api, /\.\.\.current,[\s\S]*\[capability\]: enabled/);
assert.match(messageBubble, /<video[\s\S]*?controls[\s\S]*?preload="metadata"/);
assert.match(messageBubble, /<audio[\s\S]*?controls[\s\S]*?preload="metadata"/);
assert.match(messageBubble, /readImageDataUrl\(pathValue\)/);
assert.match(messageBubble, /message-image-preview-fallback/);
assert.match(css, /\.message-video-player video\s*\{/);
assert.match(css, /\.message-audio-player audio\s*\{/);
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
