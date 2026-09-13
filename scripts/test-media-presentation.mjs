import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { loadChatTranscript } from './helpers/load-chat-transcript.mjs';

const { mediaPresentationKey: key, toolOutputPresentation: present, createToolOutputProjector } = await loadChatTranscript({
  source: `export { mediaPresentationKey, toolOutputPresentation, createToolOutputProjector } from ${JSON.stringify(resolve('src/features/chatMessages/mediaPresentation.tsx'))};`,
  globals: { TextEncoder, TextDecoder, process: { env: { NODE_ENV: 'production' } } },
});
const image = (path, extra = {}) => ({ id: path, name: 'apple.png', path, type: 'image', display: 'inline', ...extra });
// Historical presentation records share the native artifact renderer with current MCP results.
const execution = artifacts => ({ id: 'present', name: 'present_artifact', state: 'completed', artifacts });

test('local path spellings share an identity without merging distinct remote or POSIX resources', () => {
  const local = 'C:\\Users\\EDY\\Pictures\\apple photo.png';
  for (const path of [local, local.replaceAll('\\', '\\\\'), 'c:/users/edy/pictures/apple photo.png',
    'file:///C:/Users/EDY/Pictures/apple%20photo.png', 'cardbush-file:///C:/Users/EDY/Pictures/apple%20photo.png',
    'cardbush-file://c/Users/EDY/Pictures/apple%20photo.png']) {
    assert.equal(key(path), key(local), path);
  }
  assert.equal(key('\\\\server\\share\\apple.png'), key('file://server/share/apple.png'));
  for (const [a, b] of [
    ['C:/first/apple.png', 'C:/second/apple.png'],
    ['/tmp/Apple.png', '/tmp/apple.png'],
    ['https://example.com/apple.png?v=1', 'https://example.com/apple.png?v=2'],
    ['https://example.com/Apple.png', 'https://example.com/apple.png'],
    ['C:/apple%20photo.png', 'file:///C:/apple%20photo.png'],
  ]) assert.notEqual(key(a), key(b), `${a} must remain distinct from ${b}`);
});

test('one turn derives one media presentation from original execution facts and current path aliases', () => {
  const first = image('C:\\workspace\\apple.png'), latest = image('c:/workspace/apple.png', { id: 'latest', size: 50 });
  const other = image('C:/other/apple.png'), attachment = image('C:/workspace/card.png', { display: 'attachment' });
  const input = [execution([first]), execution([latest, other, attachment])];
  const original = JSON.stringify(input), result = present(input, [{ from: 'C:/workspace', to: 'D:/moved' }]);
  assert.equal(result.artifacts.length, 3);
  assert.equal(result.artifacts[0].id, 'latest');
  assert.equal(result.artifacts[0].path, 'D:/moved/apple.png');
  assert.equal(result.inlineMedia.get(key(first.path)), result.artifacts[0]);
  assert.equal(result.inlineMedia.get(key('D:/moved/apple.png')), result.artifacts[0]);
  assert.equal(result.inlineMedia.get(key(other.path)), other);
  assert.equal(result.inlineMedia.has(key(attachment.path)), false, 'an attachment card does not suppress an image preview');
  assert.equal(JSON.stringify(input), original, 'rendering never rewrites history or tool output');
  assert.equal(present([]).inlineMedia.size, 0, 'one turn cannot suppress media in another turn');
});

test('ordinary filenames and opaque plugin UI do not fabricate presented media', () => {
  const result = present([{ id: 'call', name: 'mcp_call', state: 'completed', output: 'C:/apple.png',
    metadata: { resourceUri: 'ui://plugin-preview' } }]);
  assert.equal(result.artifacts.length, 0);
  assert.equal(result.inlineMedia.size, 0);
  for (const type of ['image', 'video', 'audio']) {
    const artifact = image(`C:/result-${type}`, { type });
    assert.equal(present([execution([artifact])]).inlineMedia.has(key(artifact.path)), true);
  }
});

test('loop media stays with its first producing call while later observations enrich it', () => {
  const first = image('C:\\workspace\\apple.png');
  const latest = image('file:///C:/workspace/apple.png', { id: 'inspected-again', size: 75 });
  const video = { id: 'video', path: 'C:/workspace/clip.mp4', name: 'clip.mp4', type: 'video' };
  const audio = { id: 'audio', path: 'C:/workspace/voice.mp3', name: 'voice.mp3', type: 'audio' };
  const input = [
    { ...execution([first]), id: 'generate' },
    { ...execution([latest, video, audio]), id: 'inspect' },
  ];
  const original = JSON.stringify(input);
  const result = present(input, [{ from: 'C:/workspace', to: 'D:/moved' }]);
  assert.deepEqual([...result.mediaByExecution.keys()], ['generate', 'inspect']);
  assert.equal(result.mediaByExecution.get('generate')[0].id, 'inspected-again');
  assert.equal(result.mediaByExecution.get('generate')[0].path, 'D:/moved/apple.png');
  assert.deepEqual(Array.from(result.mediaByExecution.get('inspect'), item => item.type), ['video', 'audio']);
  assert.equal(result.mediaByExecution.get('generate')[0], result.inlineMedia.get(key(first.path)));
  assert.equal(JSON.stringify(input), original, 'anchoring is a projection, never an edit to runtime history');
});

test('tool lifecycle and unrelated output retain media context; new/enriched/removed artifacts still update', () => {
  const project = createToolOutputProjector();
  const first = image('C:/workspace/preview.png');
  const initial = project([execution([first])]);
  for (const state of ['queued', 'running', 'completed', 'failed']) {
    const unchanged = project([
      execution([{ ...first }]),
      { id: 'next', name: 'terminal_exec', state, output: `output ${state}`, metadata: { revision: state } },
    ]);
    assert.equal(unchanged, initial, 'status-only updates do not invalidate all media consumers');
  }
  const video = { id: 'video', path: 'C:/workspace/clip.mp4', name: 'clip.mp4', type: 'video' };
  const added = project([execution([{ ...first }]), { ...execution([video]), id: 'video-tool' }]);
  assert.equal(added.artifacts.length, 2);
  assert.equal(added.artifacts[0], initial.artifacts[0], 'new outputs retain unchanged preview props');
  assert.equal(added.mediaByExecution.get('present'), initial.mediaByExecution.get('present'));
  const enriched = project([execution([{ ...first, size: 120 }])]);
  assert.equal(enriched.artifacts.length, 1);
  assert.equal(enriched.artifacts[0].size, 120);
  assert.equal(enriched.inlineMedia.get(key(first.path)), enriched.artifacts[0]);
  const remapped = project([execution([{ ...first, size: 120 }])], [{ from: 'C:/workspace', to: 'D:/moved' }]);
  assert.equal(remapped.artifacts[0].path, 'D:/moved/preview.png');
  assert.equal(project([]).inlineMedia.size, 0, 'removal cannot leave a stale suppression map');
  assert.equal(createToolOutputProjector()([]).artifacts.length, 0, 'another transcript has its own cache');
});
