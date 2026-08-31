import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const api = read('src', 'backend', 'api.ts');
const provider = read('packages', 'bush-provider-openai', 'src', 'responses.ts');
const runtimeChat = read('src', 'backend', 'runtimeChat.ts');
const bubble = read('src', 'features', 'chatMessages', 'MessageBubble.tsx');
const hook = read('src', 'hooks', 'useCardbushChat.ts');
const styles = read('src', 'styles', 'app.css');

for (const reason of [
  'llm-first-activity-timeout',
  'llm-stream-idle-timeout',
  'llm-call-timeout',
]) {
  assert.match(bubble, new RegExp(reason));
}

assert.match(provider, /timeout: config\.timeoutMs/);
assert.match(provider, /maxRetries: 0/);
assert.match(provider, /code: "provider_connection_error"/);
assert.match(runtimeChat, /case 'provider_retry'/);
assert.doesNotMatch(api, /function localizedLlmTimeoutMessage/);
assert.match(bubble, /function assistantTimeoutPresentation/);
assert.match(bubble, /className="assistant-timeout-notice"/);
assert.match(bubble, /data-timeout-reason=\{timeoutPresentation\.reason\}/);
assert.match(styles, /\.assistant-timeout-notice\s*\{/);
assert.match(bubble, /function assistantFailurePresentation/);
assert.match(bubble, /status !== 'failed'/);
assert.match(bubble, /data-failure-reason=\{failurePresentation\.reason\}/);
assert.match(bubble, /role="alert"/);
assert.match(hook, /terminal\.status === 'failed'/);
assert.match(hook, /assistant-terminal-/);

console.log('LLM timeout frontend contract tests passed');
