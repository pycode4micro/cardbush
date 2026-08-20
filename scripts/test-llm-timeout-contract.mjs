import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const api = read('src', 'backend', 'api.ts');
const bubble = read('src', 'features', 'chatMessages', 'MessageBubble.tsx');
const styles = read('src', 'styles', 'app.css');

for (const reason of [
  'llm-first-activity-timeout',
  'llm-stream-idle-timeout',
  'llm-call-timeout',
]) {
  assert.match(api, new RegExp(reason));
  assert.match(bubble, new RegExp(reason));
}

assert.match(api, /function localizedLlmTimeoutMessage/);
assert.match(api, /stopDetails\.limit_reason/);
assert.match(api, /stopDetails:\s*asOptionalRecord\(item\.stop_details/);
assert.match(bubble, /function assistantTimeoutPresentation/);
assert.match(bubble, /className="assistant-timeout-notice"/);
assert.match(bubble, /data-timeout-reason=\{timeoutPresentation\.reason\}/);
assert.match(styles, /\.assistant-timeout-notice\s*\{/);

console.log('LLM timeout frontend contract tests passed');
