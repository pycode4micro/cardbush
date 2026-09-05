import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadChatTranscript } from './helpers/load-chat-transcript.mjs';

const root = process.cwd();
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const api = read('src', 'backend', 'api.ts');
const provider = read('packages', 'bush-provider-openai', 'src', 'responses.ts');
const providerFailure = read('packages', 'bush-provider-openai', 'src', 'providerFailure.ts');
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
assert.match(provider, /yield providerFailureEvent\(/);
assert.match(providerFailure, /code: "provider_client_error"[\s\S]*?retryable: false/);
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
assert.match(hook, /applyTurnTerminalSnapshot\(/);
const { applyTurnTerminalSnapshot } = await loadChatTranscript();
const failed = applyTurnTerminalSnapshot({}, 'session', '', {
  turnId: 'timeout-turn', status: 'failed', stopped: false,
  stopReason: 'llm-first-activity-timeout',
});
assert.equal(failed.session[0].id, 'assistant-terminal-timeout-turn');
assert.equal(failed.session[0].status, 'failed');
assert.equal(failed.session[0].metadata.stop_reason, 'llm-first-activity-timeout');

console.log('LLM timeout frontend contract tests passed');
