import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (...parts) => fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');
const localPaths = read('src', 'shared', 'localPaths.ts');
const messageMedia = read('src', 'features', 'messageImages.ts');
const messageBubble = read('src', 'features', 'chatMessages', 'MessageBubble.tsx');
const chatHook = read('src', 'hooks', 'useCardbushChat.ts');
const api = read('src', 'backend', 'api.ts');
const types = read('src', 'types.ts');
const css = read('src', 'styles', 'app.css');
const electronMain = read('electron', 'main.ts');

assert.match(localPaths, /export function isVideoPath/);
assert.match(localPaths, /export function isAudioPath/);
assert.match(messageMedia, /export function splitMessageMedia/);
assert.match(types, /type:\s*'image' \| 'video' \| 'audio' \| 'document'/);
assert.match(chatHook, /isVideoPath\(pathValue\)[\s\S]*?'video'/);
assert.match(chatHook, /isAudioPath\(pathValue\)[\s\S]*?'audio'/);
assert.match(api, /function messageAttachmentsFromPayload/);
assert.match(api, /attachments:\s*attachments\.length > 0 \? attachments : undefined/);
assert.match(messageBubble, /<video[\s\S]*?controls[\s\S]*?preload="metadata"/);
assert.match(messageBubble, /<audio[\s\S]*?controls[\s\S]*?preload="metadata"/);
assert.match(css, /\.message-video-player video\s*\{/);
assert.match(css, /\.message-audio-player audio\s*\{/);
assert.match(electronMain, /status:\s*206/);
assert.match(electronMain, /'content-range':\s*`bytes/);
assert.match(electronMain, /'accept-ranges':\s*'bytes'/);
assert.match(electronMain, /function videoMimeTypeForPath/);

console.log('message media contract tests passed');
