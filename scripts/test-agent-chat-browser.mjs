import assert from 'node:assert/strict';
import test from 'node:test';
import { chatBrowserCommand } from '../dist-electron/agentChatBrowser.mjs';
import { commandSuggestions, applyChatSuggestion } from '../dist-electron/agentChatCompletion.mjs';

test('browser commands offer both browsers and keep pairing receipts in terminal output only', async () => {
  const calls = [], output = [], committed = [], signal = new AbortController().signal;
  const client = { async call(operation, input) { calls.push({ operation, input });
    return input.action === 'pair' ? { code: 'CB2.fixture.private-secret', expiresAt: '2026-10-24T12:00:00Z', browser: input.browser, extensionPath: 'C:\\fixture\\extension' }
      : { state: 'running', connector: { connections: [], defaultConnectionId: '' } }; } };
  const io = { commitInput: text => committed.push(text), status: text => output.push(text) };
  assert.equal(await chatBrowserCommand('explain /browser', client, io, signal), false);
  for (const browser of ['chrome', 'edge']) {
    const hints = commandSuggestions('/browser pair ', 14, []);
    assert.deepEqual(hints.items.map(item => item.value), ['pair chrome', 'pair edge']);
    const chosen = applyChatSuggestion('/browser pair ', hints, browser === 'chrome' ? 0 : 1).line;
    assert.equal(await chatBrowserCommand(chosen + ' Work', client, io, signal), true);
    assert.deepEqual(calls.at(-1), { operation: 'browser.connector', input: { action: 'pair', browser, label: 'Work' } });
  }
  assert.match(output.join(''), /private-secret/); assert.match(output.join(''), /Keep this CLI open/);
  assert.doesNotMatch(JSON.stringify(calls) + JSON.stringify(committed), /private-secret/, 'pairing code is never submitted as input');
  await chatBrowserCommand('/browser', client, io, signal);
  assert.match(output.join(''), /\/browser pair chrome/); assert.match(output.join(''), /\/browser pair edge/);
  const count = calls.length;
  for (const command of ['/browser pair safari', '/browser pair chrome\nrevoke id', '/browser revoke bad-id']) {
    // Multiline labels are rejected by the parser before reaching the Agent.
    await chatBrowserCommand(command, client, io, signal);
  }
  assert.equal(calls.length, count);
});

test('browser management validates IDs, reports failure and preserves cancellation', async () => {
  const calls = [], output = [], id = '1'.repeat(32), signal = new AbortController().signal;
  const io = { commitInput() {}, status: text => output.push(text) };
  const client = { async call(operation, input) { calls.push(input); throw new Error('connector disabled'); } };
  await chatBrowserCommand('/browser default ' + id, client, io, signal);
  await chatBrowserCommand('/browser revoke ' + id, client, io, signal);
  assert.deepEqual(calls, [{ action: 'select-default', id }, { action: 'revoke', id }]);
  assert.match(output.join(''), /Browser setup unavailable.*connector disabled/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(chatBrowserCommand('/browser', client, io, controller.signal), { name: 'AbortError' });
});
