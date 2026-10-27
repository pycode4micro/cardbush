import assert from 'node:assert/strict';
import test from 'node:test';
import { chatBrowserCommand } from '../dist-electron/agentChatBrowser.mjs';
import { commandSuggestions, applyChatSuggestion } from '../dist-electron/agentChatCompletion.mjs';

test('browser retry is explicit and reports the latest handshake without changing pairing', async () => {
  const calls = [], output = [];
  const client = { async call(operation, input) { calls.push(input); return { state: 'running', connector: {
    connections: [], defaultConnectionId: '', connectionAttempt: { at: '2026-10-25T15:00:00Z', stage: 'rejected', reason: 'pairing_not_found' } } }; } };
  await chatBrowserCommand('/browser retry', client, { commitInput() {}, status: text => output.push(text) }, new AbortController().signal);
  assert.deepEqual(calls, [{ action: 'retry' }]);
  assert.match(output.join(''), /Latest browser handshake: rejected \(pairing_not_found\)/);
});

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

test('host failures show their recovery action without asking the user to reinstall or pair the extension', async () => {
  const output = [];
  const client = { async call() { return { shared: true, state: 'unavailable', error: 'The previous connector is still active.',
    nextStep: 'Close the older App and retry /browser status.', extensionPath: 'extension' }; } };
  await chatBrowserCommand('/browser status', client, { commitInput() {}, status: text => output.push(text) }, new AbortController().signal);
  assert.match(output.join(''), /previous connector is still active.*\nClose the older App/);
  assert.doesNotMatch(output.join(''), /pair chrome|Install or reload|approve the first/);
});

test('local CLI status directs first-use consent without creating a pairing code', async () => {
  for (const state of ['running', 'disabled']) {
    const calls = [], output = [];
    const client = { async call(operation, input) { calls.push({ operation, input });
      return { shared: true, state, connector: { connections: [], defaultConnectionId: '' } }; } };
    await chatBrowserCommand('/browser status', client, { commitInput() {}, status: text => output.push(text) }, new AbortController().signal);
    const text = output.join('');
    assert.deepEqual(calls, [{ operation: 'browser.connector', input: { action: 'status' } }]);
    if (state === 'disabled') {
      assert.match(text, /Enable the Browser Use plugin in \/settings/);
      assert.doesNotMatch(text, /pair chrome|Install or reload|approve the first/);
      continue;
    }
    assert.match(text, /first local connection in the CardBush extension window; no pairing code is needed/);
    assert.match(text, /local App and CLI share this connection and reconnect automatically.*restarts/);
    assert.match(text, /Chrome\/Edge work without the desktop App; integrated CardBush tabs require the App/);
    assert.match(text, /For manual connection only: \/browser pair/);
    assert.doesNotMatch(text, /No paired browsers|Pairing belongs to this Agent server/);
  }
});

test('standalone and remote CLI status offers pairing with that Agent instead of local consent', async () => {
  const calls = [], output = [];
  const client = { async call(operation, input) { calls.push(input);
    return { shared: false, state: 'running', connector: { connections: [], defaultConnectionId: '' } }; } };
  await chatBrowserCommand('/browser', client, { commitInput() {}, status: text => output.push(text) }, new AbortController().signal);
  const text = output.join('');
  assert.deepEqual(calls, [{ action: 'status' }]);
  assert.match(text, /manual connection or remote Agent pairing, use \/browser pair chrome or \/browser pair edge/);
  assert.match(text, /Agent server keeps separate connections from the local App\/CLI/);
  assert.doesNotMatch(text, /system dialog|no pairing code is needed|local App and CLI share/);
});

test('offline CLI profiles preserve identity and use saved connections instead of new pairing', async () => {
  for (const shared of [true, false]) {
    const calls = [], output = [], id = '1'.repeat(32);
    const client = { async call(operation, input) { calls.push(input);
      return { shared, state: 'running', connector: { defaultConnectionId: id,
        connections: [{ id, browser: 'edge', label: 'Work', connected: false }] } }; } };
    await chatBrowserCommand('/browser', client, { commitInput() {}, status: text => output.push(text) }, new AbortController().signal);
    const text = output.join('');
    assert.deepEqual(calls, [{ action: 'status' }]);
    assert.ok(text.includes(id)); assert.match(text, /edge\s+Work\s+offline/);
    assert.match(text, /original browser profile.*retries up to three times/);
    assert.match(text, /waits for you to click Connect/);
    assert.match(text, /temporary disconnect does not require a new pairing code/);
    assert.doesNotMatch(text, /approve the first local connection|No paired browsers/);
  }
});

test('browser completion describes bounded recovery and labels both pairing commands as manual or remote', () => {
  const top = commandSuggestions('/brow', 5, []).items.find(item => item.value === '/browser ');
  assert.match(top.description, /bounded connection recovery/);
  assert.ok(commandSuggestions('/browser ', 9, []).items.some(item => item.value === 'retry'));
  assert.doesNotMatch(top.description, /pairing code/);
  const choices = commandSuggestions('/browser pair ', 14, []).items;
  assert.deepEqual(choices.map(item => item.value), ['pair chrome', 'pair edge']);
  for (const choice of choices) assert.match(choice.description, /manual connection or remote Agent pairing/);
});
