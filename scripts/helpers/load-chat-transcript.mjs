import assert from 'node:assert/strict';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { build } from 'vite';

export const transcriptDirectory = path.resolve(
  import.meta.dirname, '../../src/features/chatMessages/transcript',
);
export const transcriptModules = [
  'assistantStreamBuffer', 'messageFacts', 'toolExecutionMerge',
  'loopHistory', 'liveMessageUpdates', 'messageProjection',
];

// Load the actual modules, including their real relative dependencies. Unlike
// extracting functions from a Hook or stubbing require(), this checks exports,
// module initialization and dependency resolution as well as function behavior.
export async function loadChatTranscript({ globals = {}, source } = {}) {
  const id = '\0cardbush-transcript-test.ts';
  const entrySource = source ?? transcriptModules.map(name =>
    `export * from ${JSON.stringify(path.join(transcriptDirectory, name + '.ts'))};`,
  ).join('\n');
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [{
      name: 'chat-transcript-test-entry',
      resolveId: value => value.endsWith('__transcript_test_entry__.ts') ? id : undefined,
      load: value => value === id ? entrySource : undefined,
    }],
    build: {
      write: false,
      minify: false,
      lib: { entry: path.join(transcriptDirectory, '__transcript_test_entry__.ts'), formats: ['cjs'] },
    },
  });
  const chunks = (Array.isArray(result) ? result : [result]).flatMap(r => r.output);
  const entry = chunks.find(chunk => chunk.type === 'chunk' && chunk.isEntry);
  assert.ok(entry, 'Missing bundled transcript entry');
  assert.equal(chunks.filter(chunk => chunk.type === 'chunk').length, 1);
  const module = { exports: {} };
  vm.runInNewContext(entry.code, {
    module, exports: module.exports, URL, Date, Map, Set,
    crypto: webcrypto,
    window: { setTimeout, clearTimeout },
    ...globals,
  });
  return module.exports;
}
