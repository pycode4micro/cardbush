import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const api = read('src', 'backend', 'api.ts');
const provider = read('packages', 'bush-provider-openai', 'src', 'chatCompletions.ts');
const runtimeChat = read('src', 'backend', 'runtimeChat.ts');
const bubble = read('src', 'features', 'chatMessages', 'MessageBubble.tsx');
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

console.log('LLM timeout frontend contract tests passed');
