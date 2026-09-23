import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
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
assert.match(bubble, /data-failure-reason=\{failurePresentation\.tone === 'neutral' \? undefined : failurePresentation\.reason\}/);
assert.match(bubble, /role=\{failurePresentation\.tone === 'neutral' \? 'status' : 'alert'\}/);
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

// Execute the real presentation functions, including legacy histories without
// live terminal details, instead of matching the new output-limit wording.
const syntax = ts.createSourceFile('MessageBubble.tsx', bubble, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const presentationSource = syntax.statements.filter(statement => ts.isFunctionDeclaration(statement) &&
  ['assistantFailurePresentation', 'recordFromUnknown'].includes(statement.name?.text)).map(statement => statement.getText(syntax)).join('\n');
const presentationModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(presentationSource + '\nexport { assistantFailurePresentation };', {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { module: presentationModule, exports: presentationModule.exports });
for (const language of ['zh', 'en']) {
  const message = { role: 'assistant', status: 'failed', metadata: { stop_reason: 'model_output_limit_exceeded',
    stop_details: { maxOutputTokens: 8192, continuationAttempts: 0 } } };
  const notice = presentationModule.exports.assistantFailurePresentation(message, language);
  assert.equal(notice.reason, 'model_output_limit_exceeded');
  assert.match(notice.detail, /8,192/);
  assert.match(notice.detail, language === 'zh' ? /提高最大输出/ : /Increase the maximum output/);
  assert.doesNotMatch(notice.detail, /NaN|undefined|自动续接|Automatic continuation/);
  const historyNotice = presentationModule.exports.assistantFailurePresentation({ ...message, metadata: { stop_reason: message.metadata.stop_reason } }, language);
  assert.doesNotMatch(historyNotice.detail, /NaN|undefined/);
  assert.equal(presentationModule.exports.assistantFailurePresentation({ ...message, status: 'completed' }, language), null);
}

console.log('LLM timeout frontend contract tests passed');
