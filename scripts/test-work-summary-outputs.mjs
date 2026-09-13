import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { loadChatTranscript } from './helpers/load-chat-transcript.mjs';

const { workSummaryOutputs: outputs, fileTypeDescriptor: icon, inspectorMediaTarget: preview, isInspectorBrowserTarget: browser } = await loadChatTranscript({
  conditions: ['node'],
  source: [
    ['workSummaryOutputs', 'src/features/chat/workSummaryOutputs.ts'],
    ['fileTypeDescriptor', 'src/features/chatMessages/FileTypeIcon.tsx'],
    ['inspectorMediaTarget, isInspectorBrowserTarget', 'src/features/inspector/inspectorTargets.ts'],
  ].map(([exports, file]) => `export { ${exports} } from ${JSON.stringify(resolve(file))};`).join('\n'),
  globals: { TextEncoder, TextDecoder, process: { env: { NODE_ENV: 'production' } } },
});
const artifact = (path, type = 'document', name = path.split('/').at(-1)) => ({ id: path, path, type, name });
const message = (id, extra = {}) => ({ id, role: 'assistant', content: '', ...extra });
const execution = (id, artifacts = [], extra = {}) => ({ id, name: 'generate', state: 'completed', artifacts, ...extra });
const report = (messageId, paths) => ({ id: messageId, messageId, files: paths.map(path => ({ path, additions: 22, deletions: 1, diff: '', lines: [] })) });

test('recent outputs combine file changes, recursive tool artifacts and assistant attachments without mutating history', () => {
  const messages = [message('code'), message('result', {
    attachments: [artifact('D:/out/voice.wav', 'audio')],
    loopHistory: [message('loop', { loopHistory: [message('nested', { toolExecutions: [execution('make', [
      artifact('D:/out/clip.mp4', 'video'), artifact('D:/out/photo.png', 'image'),
    ])] })] })],
    toolExecutions: [execution('read-again', [artifact('file:///D:/out/photo.png', 'image')])],
  })];
  const changes = [report('code', ['D:/src/prep_refs.py', 'D:/src/uploader.py', 'D:/plugin/uploader.py'])];
  const before = JSON.stringify({ messages, changes });
  const result = outputs(messages, changes);
  assert.equal(result.length, 6);
  assert.equal(result[0].name, 'voice.wav', 'new media should appear ahead of older edits');
  assert.equal(result.filter(item => item.path === 'D:/out/photo.png').length, 1);
  assert.equal(result.filter(item => item.name === 'uploader.py').length, 2, 'same basename is not the same file');
  assert.equal(result.find(item => item.name === 'prep_refs.py').change.additions, 22);
  assert.equal(JSON.stringify({ messages, changes }), before);
});

test('Markdown media follows native links, references and workspace resolution, excluding code examples and inputs', () => {
  const content = [
    '![成片](<C:/work/中文 clip (1).mp4>)',
    '[配音][voice]',
    '[voice]: <file:///C:/work/voice%20one.wav>',
    '[下载](./out/clip.webm)',
    '![封面](https://example.com/Photo.PNG?token=ABC)',
    '', 'C:/work/standalone.mp3', '',
    '`![代码](C:/work/inline.png)`',
    '```markdown', '![示例](C:/work/example.mp4)', 'C:/work/fenced.wav', '```',
    '处理 C:/work/mentioned.mp4 后再输出。',
    '![bad](javascript:alert)',
  ].join('\n');
  const result = outputs([
    message('input', { role: 'user', content: '![输入](C:/work/input.png)', attachments: [artifact('C:/work/source.mp4', 'video')] }),
    message('result', { content, toolExecutions: [execution('logs', [], { output: 'C:/work/log-only.wav' })] }),
  ], [], 'C:/work');
  assert.deepEqual(Array.from(result, item => item.path).sort(), [
    'C:/work/中文 clip (1).mp4', 'C:/work/voice one.wav', 'C:/work/out/clip.webm',
    'https://example.com/Photo.PNG?token=ABC', 'C:/work/standalone.mp3',
  ].sort());
  assert.equal(result.find(item => item.name === 'voice one.wav').type, 'audio');
});

test('path aliases deduplicate changes and delivered media while remote signatures and POSIX case stay distinct', () => {
  const messages = [message('old'), message('new', { toolExecutions: [execution('media', [
    artifact('file:///C:/old/clip.mp4', 'video'), artifact('d:/moved/CLIP.mp4', 'video'),
    artifact('/tmp/Voice.wav', 'audio'), artifact('/tmp/voice.wav', 'audio'),
    artifact('https://example.com/clip.mp4?sig=A', 'video'), artifact('https://example.com/clip.mp4?sig=a', 'video'),
  ])] })];
  const result = outputs(messages, [report('old', ['C:/old/clip.mp4'])], '', [{ from: 'C:/old', to: 'D:/moved' }]);
  assert.equal(result.length, 5);
  assert.equal(result.find(item => item.change)?.change.path, 'C:/old/clip.mp4', 'review keeps its original selector');
  assert.equal(result.find(item => item.change)?.type, 'video');
});

test('declared media works without extensions, including attachment-style and inline audio artifacts', () => {
  const data = 'data:audio/wav;base64,UklGRg==';
  const result = outputs([message('media', { toolExecutions: [execution('native', [
    { ...artifact('https://example.com/download?id=9', 'video', 'final.mp4'), display: 'attachment' },
    artifact(data, 'audio', 'voice.wav'),
    artifact('C:/out/no-extension', 'audio', 'narration'),
  ])] })], []);
  assert.equal(result.length, 3);
  assert.equal(result.find(item => item.path === data).name, 'voice.wav');
  assert.equal(result.find(item => item.path.startsWith('https:')).name, 'final.mp4');
  for (const item of result) assert.equal(preview(item.path, item.type)?.kind, item.type);
  assert.equal(browser('https://example.com/download?id=9', 'video'), false);
  assert.equal(browser('https://example.com/download?id=9'), true, 'ordinary web navigation is unchanged');
  assert.equal(preview('data:text/html;base64,PGgxPg==', 'video'), null);
  assert.equal(preview(data, 'video'), null);
  assert.equal(preview('javascript:alert(1)', 'image'), null);
});

test('extension icons match source files, signed media URLs, literal local filenames and declared media', () => {
  assert.equal(icon('prep_refs.py').label, 'PY');
  assert.equal(icon('src/view.tsx').kind, 'react');
  assert.equal(icon('https://example.com/My%20Clip.MP4?sig=ABC').tone, 'video');
  assert.equal(icon('C:/Voice #1.FLAC').tone, 'audio');
  assert.equal(icon('C:/picture.png#notes.md').tone, 'document');
  assert.equal(icon('file:///C:/photo%20one.avif').tone, 'image');
  assert.equal(icon('https://example.com/download', 'audio').tone, 'audio');
  assert.equal(icon('data:video/mp4;base64,AAAA', 'video').tone, 'video');
  assert.equal(outputs([], []).length, 0);
});
