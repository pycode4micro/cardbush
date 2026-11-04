import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'vite';

const result = await build({ configFile: false, logLevel: 'silent', build: { write: false, minify: false,
  lib: { entry: 'src/features/assistant/assistantError.ts', formats: ['es'] } } });
const output = (Array.isArray(result) ? result[0] : result).output.find(item => item.type === 'chunk').code;
const { assistantErrorText } = await import('data:text/javascript;base64,' + Buffer.from(output).toString('base64'));

test('missing model bindings show actionable localized text without opaque IDs and preserve unrelated errors', () => {
  const raw = 'Provider binding private-model-id@sha256:opaque-revision is unavailable.';
  assert.match(assistantErrorText(raw, 'zh'), /模型配置不可用.*消息已保留/);
  assert.match(assistantErrorText(raw, 'en'), /model configuration is unavailable.*message is saved/);
  for (const language of ['zh', 'en']) {
    assert.doesNotMatch(assistantErrorText(raw, language), /private-model-id|opaque-revision|Provider binding/);
    assert.equal(assistantErrorText('quota_exceeded', language), 'quota_exceeded');
  }
});
