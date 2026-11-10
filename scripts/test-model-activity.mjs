import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as protocol from '@cardbush/bush-protocol';
import * as i18n from '@cardbush/platform/i18n';

test('GUI model activity follows stream facts, keeps compaction visible and clears terminal turns', () => {
  const compiled = ts.transpileModule(readFileSync('src/runtime-client/modelActivity.ts', 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const module = { exports: {} };
  let warnings = 0;
  vm.runInNewContext(compiled.outputText, { module, exports: module.exports, console: { warn() { warnings++; } },
    require: name => {
      if (name === '../i18n') return i18n;
      assert.equal(name, '@cardbush/bush-protocol');
      return protocol;
    } });
  const { publishModelActivity: publish, modelActivityLabel: label, modelActivityForTurn: state, subscribeModelActivity: subscribe } = module.exports;
  let changes = 0; const unsubscribe = subscribe(() => changes++);
  const emit = (kind, payload = {}, turnId = 'one', seconds = 0) => publish({ kind, payload, turnId, createdAt: new Date(seconds * 1000).toISOString() });
  emit('turn_accepted');
  emit('turn_started'); assert.equal(label('one', 'en'), 'Preparing to chat');
  const diagnostic = { stage: 'idle', activeBlockType: 'thinking', thinkingChars: 0, textChars: 0 };
  emit('provider_stream_diagnostic', diagnostic); assert.equal(label('one', 'zh'), '等待模型思考结果');
  const count = changes; emit('provider_stream_diagnostic', diagnostic); assert.equal(changes, count);
  emit('provider_stream_diagnostic', { ...diagnostic, activeBlockType: 'tool_use' }, 'two');
  assert.equal(label('two', 'en'), 'Preparing tool call'); assert.equal(label('one', 'en'), 'Thinking (no public output)');
  emit('context_compaction_started'); emit('provider_stream_diagnostic', diagnostic);
  assert.equal(label('one', 'en'), 'Compacting context');
  emit('context_compaction_completed'); emit('provider_retry'); assert.equal(label('one', 'zh'), '等待重试');
  emit('tool_queued'); assert.equal(label('one', 'en'), '');
  emit('turn_terminal', {}, 'one', 28); emit('turn_terminal', {}, 'two'); assert.equal(label('two', 'en'), '');
  const terminal = state('one');
  emit('provider_retry'); emit('turn_started'); emit('turn_terminal', {}, 'one', 35);
  assert.equal(state('one'), terminal, 'replay and late receipts cannot restart a settled clock');
  assert.equal(Date.parse(terminal.completedAt) - Date.parse(terminal.startedAt), 28000);
  const badListener = subscribe(() => { throw new Error('fixture observer failure'); });
  assert.doesNotThrow(() => emit('turn_started', {}, 'three'));
  assert.equal(label('three', 'en'), 'Preparing to chat'); assert.equal(warnings, 1);
  badListener(); emit('turn_terminal', {}, 'three');
  unsubscribe();
});
