import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { stripVTControlCharacters } from 'node:util';
import { chatHeader, ChatMarkdown, terminalWidth, terminalClip } from '../dist-electron/agentChatPresentation.mjs';
import { AgentChatCompletion, applyChatSuggestion, commandSuggestions, choiceSuggestions } from '../dist-electron/agentChatCompletion.mjs';
import { ChatPasteDecoder, ChatPastes } from '../dist-electron/agentChatInput.mjs';
import { NativeChatTerminal } from '../dist-electron/agentChatTerminal.mjs';
import { ChatLiveViewport, chatInputViewport } from '../dist-electron/agentChatViewport.mjs';
import { runtimeToolLifecycle } from '../packages/bush-protocol/dist/index.js';
import { AgentChatReferences } from '../dist-electron/agentChatReferences.mjs';

// Readline also consults process.env.TERM internally. Match the emulated TTY.
process.env.TERM = 'xterm';

const identity = { name: 'CardBush CLI', model: 'fixture-model', permission: 'Approval mode', local: true,
  workspace: 'D:\\中文项目\\衣服 👩🏽‍💻', sessionId: 'session-offline-presentation' };
const event = (kind, payload = {}, createdAt = '2026-10-22T03:00:00.000Z') => ({ kind, payload, createdAt, sequence: 1, turnId: 'turn', sessionId: 'session' });
function tty(t, { columns = 80, stdout = true, env = { NO_COLOR: '' } } = {}) {
  const input = Object.assign(new PassThrough(), { isTTY: true, raw: false, setRawMode(raw) { this.raw = raw; return this; } });
  let outputText = '', statusText = '', combined = '', interrupts = 0;
  const output = Object.assign(new Writable({ write(data, _encoding, done) { outputText += data.toString(); combined += data.toString(); done(); } }), { isTTY: stdout, columns });
  const status = Object.assign(new Writable({ write(data, _encoding, done) { statusText += data.toString(); combined += data.toString(); done(); } }), { isTTY: true, columns });
  const terminal = new NativeChatTerminal(() => { interrupts++; }, { input, output, status, env });
  t.after(() => terminal.close());
  return { terminal, input, output, status, get stdout() { return outputText; }, get stderr() { return statusText; }, get combined() { return combined; }, get interrupts() { return interrupts; } };
}
const tick = () => delay(5);
async function waitForPaint(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate() && Date.now() < deadline) await delay(10);
  assert.ok(predicate(), 'the scheduled terminal repaint must settle');
}

test('opaque model phases update the status without entering the reply or disturbing a draft', async t => {
  const f = tty(t, { columns: 100 });
  f.terminal.enableLiveInput(() => {}); f.terminal.beginTurn();
  f.input.write('draft'); await tick();
  const diagnostic = { format: 'anthropic.messages.v1', stage: 'idle', elapsedMs: 360000, idleMs: 359000,
    eventCount: 2, thinkingChars: 0, textChars: 0, toolArgumentChars: 0, activeBlockType: 'thinking', messageStopReceived: false, aborted: false };
  f.terminal.event(event('provider_stream_diagnostic', diagnostic));
  await waitForPaint(() => f.stderr.includes('Thinking (no public output)'));
  assert.match(f.stderr, /Thinking \(no public output\)/);
  assert.equal(f.stdout, '');
  assert.match(terminalScreen(f.combined, 100).text, /draft/);
  f.terminal.event(event('context_compaction_started', {}));
  f.terminal.event(event('provider_stream_diagnostic', diagnostic));
  await waitForPaint(() => terminalScreen(f.combined, 100).text.includes('Compacting context'));
  assert.match(terminalScreen(f.combined, 100).text, /Compacting context/);
  f.terminal.finishTurn('stopped');
});

// Interpret cursor operations as a terminal would. Raw output counts alone
// cannot detect an input repaint that erases previously committed responses.
function terminalScreen(raw, columns) {
  raw = raw.replace(/\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
  const lines = [[]]; let row = 0, column = 0;
  for (const part of raw.matchAll(/\x1b\[([0-?]*)([ -/]*[@-~])|([^\x1b]+)/g)) {
    if (part[3] !== undefined) {
      for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(part[3])) {
        if (segment === '\r\n' || segment === '\n') { row++; column = 0; continue; }
        if (segment === '\r') { column = 0; continue; }
        const width = terminalWidth(segment); if (!width) continue;
        if (column + width > columns) { row++; column = 0; }
        const line = lines[row] ??= []; line[column] = segment;
        for (let i = 1; i < width; i++) line[column + i] = '';
        column += width;
      }
      continue;
    }
    const amount = Number(part[1]) || 1;
    if (part[2] === 'A') row = Math.max(0, row - amount);
    if (part[2] === 'B') row += amount;
    if (part[2] === 'G') column = amount - 1;
    if (part[2] === 'C') column += amount;
    if (part[2] === 'D') column = Math.max(0, column - amount);
    if (part[2] === 'J' && (!part[1] || part[1] === '0')) { lines.length = row + 1; (lines[row] ??= []).length = column; }
    if (part[2] === 'K') { if (part[1] === '2') lines[row] = []; else (lines[row] ??= []).length = column; }
  }
  return { text: lines.map(line => line?.join('') ?? '').join('\n'), row, column };
}

test('live editor keeps a draft and its caret through streamed output, tools, completion and resize', async t => {
  const f = tty(t, { columns: 48 }), queued = [];
  f.terminal.enableLiveInput(text => queued.push(text)); f.terminal.beginTurn();
  f.input.write('alphaomega'); f.input.write('\x1b[D'.repeat(5));
  for (let index = 0; index < 8; index++) { f.terminal.write(`Response ${index}.\n`); await delay(40); }
  f.terminal.event(event('tool_running', { toolCallId: 't', toolName: 'read_file' }));
  f.terminal.event(event('tool_returned', { toolCallId: 't', toolName: 'read_file' }));
  f.input.write('中'); await delay(40);
  const visible = terminalScreen(f.combined, 48).text;
  for (let index = 0; index < 8; index++) assert.equal(visible.split(`Response ${index}.`).length, 2, visible);
  assert.match(visible, /alpha中omega/); assert.equal(visible.split('❯ ').length, 2, visible);
  f.status.columns = f.output.columns = 28; f.status.emit('resize');
  f.terminal.finishTurn('completed'); await delay(40);
  const answer = f.terminal.ask('❯ ', new AbortController().signal, true);
  f.input.write('X\r'); assert.equal(await answer, 'alpha中Xomega');
  assert.deepEqual(queued, [], 'drafts are never submitted by output or task completion');
  assert.doesNotMatch(f.combined, /\x1b\[\?1049|\x1b\[2J/);
});

test('queued questions join the transcript only before their own replies, without splitting a streamed answer', async t => {
  for (const env of [{ NO_COLOR: '' }, {}]) {
    const f = tty(t, { columns: 80, env }), queued = [];
    f.terminal.enableLiveInput(text => queued.push(text));
    const first = f.terminal.ask('❯ ', new AbortController().signal, true);
    f.input.write('为什么不是 CardBush\r');
    f.terminal.beginTurn(await first);
    f.terminal.write('First **reply');
    for (const question of ['你有什么依据', '再检查一下']) {
      for (const character of question) f.input.write(character);
      f.input.write('\r'); f.terminal.setQueued(queued.length);
    }
    await delay(45);
    const waiting = terminalScreen(f.combined, 80).text;
    assert.match(waiting, /2 queued/);
    assert.doesNotMatch(waiting, /你有什么依据|再检查一下/, 'submitted drafts are not yet conversation messages');
    f.terminal.write(' continues**.\n'); f.terminal.finishTurn('completed');
    for (const [index, question] of queued.entries()) {
      f.terminal.setQueued(queued.length - index - 1); f.terminal.beginTurn(question);
      f.terminal.write(`Reply ${index + 2}.\n`); f.terminal.finishTurn('completed');
    }
    await delay(45);
    const visible = terminalScreen(f.combined, 80).text;
    const transcript = visible.split('\n').map(line => line.trim()).filter(Boolean).join('\n');
    assert.match(transcript, /❯ 为什么不是 CardBush\nFirst reply continues\.\n✓ Completed[^\n]*\n❯ 你有什么依据\nReply 2\.\n✓ Completed[^\n]*\n❯ 再检查一下\nReply 3\.\n✓ Completed/);
    for (const question of ['为什么不是 CardBush', ...queued]) assert.equal(visible.split(question).length, 2, visible);
    assert.equal(visible.split('❯ ').length, 5, 'three committed questions and one live editor');
  }
});

test('input submitted between turns is deferred too, and folded paste display survives until execution', async t => {
  const f = tty(t); f.terminal.enableLiveInput(() => assert.fail('no turn is active'));
  f.input.write('first message\r');
  f.input.write('check '); f.input.write('\x1b[200~first line\nsecond line\x1b[201~'); f.input.write('\r');
  await delay(45);
  assert.doesNotMatch(terminalScreen(f.combined, 80).text, /first message|Paste 1/);
  const first = await f.terminal.ask('❯ ', new AbortController().signal, true);
  f.terminal.beginTurn(first); f.terminal.write('First answer.\n'); f.terminal.finishTurn('completed');
  const second = await f.terminal.ask('❯ ', new AbortController().signal, true);
  assert.equal(second, 'check first line\nsecond line');
  f.terminal.beginTurn(second); f.terminal.write('Second answer.\n'); f.terminal.finishTurn('completed');
  await delay(45);
  const visible = terminalScreen(f.combined, 80).text;
  assert.match(visible, /First answer\.[\s\S]*✓ Completed[^\n]*\n\n❯ check \[Paste 1 · 2 lines · 22 chars\]\n\n\s*Second answer\./);
  assert.equal(visible.split('[Paste 1').length, 2, visible);
  assert.doesNotMatch(visible, /second line/, 'folded input stays compact in scrollback');
});

test('continuous typing paints the current caret immediately without redrawing the surrounding footer', async t => {
  for (const env of [{ NO_COLOR: '' }, {}]) {
    const f = tty(t, { columns: 48, env }); f.terminal.enableLiveInput(() => {});
    let draft = '';
    for (const text of ['a', 'b', '中', '文', 'e\u0301', '👩🏽‍💻']) {
      const before = f.combined.length;
      f.input.write(text); draft += text;
      const screen = terminalScreen(f.combined, 48);
      assert.match(screen.text, new RegExp('❯ ' + draft));
      assert.equal(screen.column, terminalWidth('❯ ' + draft), 'the caret follows this input chunk, not a later timer');
      assert.equal(screen.row, 1);
      const update = f.combined.slice(before);
      assert.doesNotMatch(update, /\x1b\[0J|─{3}|Enter send/, 'typing cannot erase or rewrite unrelated footer rows');
    }
    const settled = f.combined;
    await delay(110);
    assert.equal(f.combined, settled, 'an empty suggestion result cannot repaint an unchanged input');
  }
});

test('streamed output keeps the displayed editor intact until a complete frame is ready', async t => {
  const f = tty(t, { columns: 48 }); f.terminal.enableLiveInput(() => {});
  f.input.write('alphaomega'); f.input.write('\x1b[D'.repeat(5)); await delay(110);
  const before = f.combined, caret = terminalScreen(before, 48);
  for (const text of ['A response', ' continues', '.\n']) {
    f.terminal.write(text);
    assert.equal(f.combined, before, 'pending output must not erase the prompt and leave its caret at the transcript');
  }
  await delay(45);
  const screen = terminalScreen(f.combined, 48);
  assert.match(screen.text, /A response continues\./);
  assert.match(screen.text, /❯ alphaomega/);
  assert.equal(screen.column, caret.column);
  f.input.write('中');
  assert.match(terminalScreen(f.combined, 48).text, /❯ alpha中omega/);
  assert.equal(terminalScreen(f.combined, 48).column, caret.column + 2);
});

test('rapid typing across wrapped lines preserves middle edits and the visible caret', async t => {
  const f = tty(t, { columns: 24 }); f.terminal.enableLiveInput(() => {});
  const draft = 'abcdefghijklmnopqrstuvwxyz'.repeat(3);
  for (let index = 0; index < draft.length; index++) {
    f.input.write(draft[index]);
    const screen = terminalScreen(f.combined, 24), offset = index + 3;
    assert.equal(screen.row, 1 + Math.floor(offset / 23));
    assert.equal(screen.column, offset % 23);
  }
  f.input.write('\x1b[D'.repeat(30)); f.input.write('中');
  const caret = terminalScreen(f.combined, 24);
  assert.equal(caret.row, 3); assert.equal(caret.column, 6);
  const answer = f.terminal.ask('❯ ', new AbortController().signal, true);
  f.input.write('\r');
  assert.equal(await answer, draft.slice(0, -30) + '中' + draft.slice(-30));
});

test('shrinking and reopening completion hints keep the input on the same screen row', () => {
  let raw = '', footer = { lines: ['─'.repeat(30), '❯ /h', '  help', '  history', '  Tab complete'], cursor: { row: 1, column: 4 } };
  const output = Object.assign(new Writable({ write(chunk, _encoding, done) { raw += chunk.toString(); done(); } }), { columns: 40 });
  const view = new ChatLiveViewport(output, () => footer);
  try {
    view.paint(); raw = '';
    footer = { lines: ['─'.repeat(30), '❯ /he', '  Enter send'], cursor: { row: 1, column: 5 } };
    view.paint();
    assert.doesNotMatch(raw, /\x1b\[0J|\n/, 'shrinking hints must retain their reserved rows without scrolling');
    raw = '';
    footer = { lines: ['─'.repeat(30), '❯ /hel', '  help', '  hello', '  Tab complete'], cursor: { row: 1, column: 6 } };
    view.paint();
    assert.doesNotMatch(raw, /\x1b\[0J|\n/, 'reopening hints reuses the same reserved rows');
  } finally { view.close(); }
});

test('closing a viewport flushes pending stdout and status once and restores cursor visibility', () => {
  let raw = '', stdout = '', stderr = '';
  const output = Object.assign(new Writable({ write(chunk, _encoding, done) { stderr += chunk; raw += chunk; done(); } }), { columns: 40 });
  const reply = new Writable({ write(chunk, _encoding, done) { stdout += chunk; raw += chunk; done(); } });
  const view = new ChatLiveViewport(output, () => ({ lines: ['❯ draft'], cursor: { row: 0, column: 7 } }));
  view.paint();
  view.write('answer\nunfinished', reply); view.write('done\n', output);
  assert.equal(stdout, '', 'response rows are pending until the next frame');
  view.close(); const closed = raw; view.close();
  assert.equal(raw, closed);
  assert.equal(stripVTControlCharacters(stdout), 'answer\nunfinished\n');
  assert.match(terminalScreen(raw, 40).text, /answer\nunfinished\ndone/);
  assert.doesNotMatch(terminalScreen(raw, 40).text, /draft/);
  assert.ok(stderr.endsWith('\x1b[?25h'));
});

test('live input viewport follows the caret within four rows without losing Unicode or long input', () => {
  for (const width of [12, 24, 80]) {
    const line = '中文 👩🏽‍💻 é tail '.repeat(40);
    for (const cursor of [0, 10, 73, line.length]) {
      const view = chatInputViewport('❯ ', line, cursor, width);
      assert.ok(view.lines.length <= 4); assert.ok(view.lines.every(row => terminalWidth(row) <= width));
      assert.ok(view.cursor.row < view.lines.length); assert.ok(view.cursor.column < width);
      assert.ok(view.clipped);
    }
  }
  assert.deepEqual(chatInputViewport('', '1234\nnext\nlast', 4, 4).cursor, { row: 1, column: 0 });
});

test('live viewport accounts for wide characters after resize and physical tab stops in code output', () => {
  let raw = '', footer = { lines: ['中'.repeat(33)], cursor: { row: 0, column: 66 } };
  const output = Object.assign(new Writable({ write(chunk, _encoding, done) { raw += chunk.toString(); done(); } }), { columns: 80 });
  const view = new ChatLiveViewport(output, () => footer);
  try {
    view.paint(); raw = ''; output.columns = 17; footer = undefined;
    view.paint(); assert.ok(raw.includes('\x1b[0m\r\x1b[4A\x1b[0J'), '33 wide glyphs reflow across five rows at 17 columns');
    raw = ''; output.columns = 12;
    view.write('a\tb\tc', output); view.paint(); view.close();
    assert.doesNotMatch(raw, /\t/);
    const screen = terminalScreen(raw, 12).text;
    assert.ok(screen.includes('a       b')); assert.ok(screen.includes('c'));
  } finally { view.close(); }
});

test('live approval temporarily owns input and restores the draft, paste references and native history', async t => {
  const f = tty(t), queued = []; f.terminal.enableLiveInput(text => queued.push(text)); f.terminal.beginTurn();
  f.input.write('keep '); f.input.write('\x1b[200~first\nsecond\x1b[201~'); f.input.write(' end');
  f.input.write('\x1b[D'.repeat(4)); f.input.write('\x1b[200~y');
  const resume = f.terminal.suspendInput();
  let answered = false;
  const answer = f.terminal.ask('Allow? [y/N]: ', new AbortController().signal, { choices: [{ value: 'n' }, { value: 'y' }] }).then(value => { answered = true; return value; });
  f.input.write('\x1b[201~'); await delay(40); assert.equal(answered, false);
  f.input.write('n\r'); assert.equal(await answer, 'n'); resume();
  f.input.write('!\r'); assert.deepEqual(queued, ['keep first\nsecond! end']);
  f.terminal.finishTurn('completed');
  const next = f.terminal.ask('❯ ', new AbortController().signal, true);
  f.input.write('\x1b[A\r'); assert.equal(await next, 'keep first\nsecond! end', 'approval answers never enter chat history');
});

test('live hints stay below input while partial output grows and Tab never submits guidance', async t => {
  const f = tty(t, { columns: 64 }), queued = []; f.terminal.enableLiveInput(text => queued.push(text)); f.terminal.beginTurn();
  f.input.write('/ste'); await delay(90); f.terminal.write('Streaming text'); await delay(110);
  f.input.write('\t'); await delay(40); assert.deepEqual(queued, []);
  f.input.write('use the existing file\r'); assert.deepEqual(queued, ['/steer use the existing file']);
  f.terminal.commitInput(queued[0]); // The controller accepts this as guidance, not a new turn.
  f.terminal.write(' continues here.\n'); await delay(40);
  const visible = terminalScreen(f.combined, 64).text;
  assert.match(visible, /Streaming text/); assert.match(visible, /continues here/);
  assert.match(visible, /\/steer use the existing file/);
  assert.equal(visible.split('❯ ').length, 3, visible); // committed message + live editor
});

test('live stdout redirection stays raw and Esc stops without consuming the draft', async t => {
  const f = tty(t, { stdout: false }); f.terminal.enableLiveInput(() => {}); f.terminal.beginTurn();
  f.input.write('keep this draft'); f.terminal.write('**raw**\n| A | B |\n');
  f.input.write('\x1b'); await delay(90); assert.equal(f.interrupts, 1);
  f.terminal.finishTurn('stopped');
  const next = f.terminal.ask('❯ ', new AbortController().signal, true);
  f.input.write('\r'); assert.equal(await next, 'keep this draft');
  assert.equal(f.stdout, '**raw**\n| A | B |\n');
});

test('artifact selection cycles with Tab, survives streaming/approval and opens only on Enter', async t => {
  const f = tty(t), inputs = [], opened = [];
  const references = new AgentChatReferences({ call: async () => assert.fail('Tab must not read or open a file') }, f.terminal, async path => opened.push(path));
  references.setScope({ sessionId: 's', turnId: 't', workspace: 'C:/work', platform: 'win32', local: true, hyperlinks: false });
  for (const name of ['one.md', 'two.csv', 'three.pptx']) references.link(name, name);
  f.terminal.setSuggestionSource(async (line, cursor) => references.suggest(line, cursor));
  f.terminal.enableLiveInput(text => inputs.push(text)); f.terminal.beginTurn();
  f.terminal.restoreDraft('/artifact '); await delay(100);
  for (const number of [1, 2, 3, 1]) {
    f.input.write('\t'); await delay(100);
    assert.match(terminalScreen(f.combined, 80).text, new RegExp(`❯ /artifact ${number}\\n`));
    f.terminal.write('The reply keeps streaming.\n');
    assert.deepEqual(opened, []); assert.deepEqual(inputs, []);
  }
  const answer = f.terminal.ask('Allow? [y/N]: ', new AbortController().signal);
  f.input.write('n\r'); assert.equal(await answer, 'n');
  await delay(100); assert.match(terminalScreen(f.combined, 80).text, /❯ \/artifact 1\n/);
  f.input.write('\r'); assert.deepEqual(inputs, ['/artifact 1']);
  await references.handle('artifact', '1', new AbortController().signal);
  assert.deepEqual(opened, ['C:\\work\\one.md']);
  f.terminal.restoreDraft('/artifact ');
  await waitForPaint(() => terminalScreen(f.combined, 80).text.includes('❯ /artifact \n'));
  f.input.write('\x1b');
  await waitForPaint(() => !terminalScreen(f.combined, 80).text.includes('❯ /artifact \n'));
  assert.equal(f.interrupts, 0, 'Esc cancels a file selection without stopping the Agent');
  assert.doesNotMatch(terminalScreen(f.combined, 80).text, /❯ \/artifact \n/);
  f.input.write('\x03'); assert.equal(f.interrupts, 1, 'Ctrl+C still stops the actual task');
});

test('live hyperlinks survive narrow wrapping without leaking URI bytes into the footer or shifting its caret', async t => {
  const f = tty(t, { columns: 28, env: { WT_SESSION: 'fixture' } });
  const references = new AgentChatReferences({ call: async () => assert.fail('rendering links does not call the host') }, f.terminal);
  references.setScope({ sessionId: 's', turnId: 't', workspace: 'C:/work', platform: 'win32', local: true, hyperlinks: f.terminal.hyperlinks });
  f.terminal.setReferenceRenderer(references); f.terminal.enableLiveInput(() => {}); f.terminal.beginTurn();
  f.input.write('keep draft');
  f.terminal.write('[A rather long clickable file label](<C:/work/中文 file.md>)\n');
  f.terminal.finishTurn('completed'); await delay(45);
  const screen = terminalScreen(f.combined, 28);
  assert.match(screen.text, /clickable\s+file/); assert.match(screen.text, /❯ keep draft/);
  assert.doesNotMatch(screen.text, /file:\/\/|%E4|\]8;;/);
  assert.equal(screen.column, terminalWidth('❯ keep draft'));
  assert.match(f.combined, /\x1b\]8;;file:/);
  assert.equal((f.combined.match(/\x1b\]8;;file:/g) ?? []).length, (f.combined.match(/\x1b\]8;;\x1b\\/g) ?? []).length);
});

function terminalBackgrounds(text) {
  let background = null;
  const erase = [], printable = [];
  for (const match of text.matchAll(/\x1b\[([0-?]*)([ -/]*[@-~])|([^\x00-\x1f\x7f-\x9f]+)/g)) {
    if (match[3]) { printable.push({ text: match[3], background }); continue; }
    const args = match[1].split(';').map(Number), command = match[2];
    if (command === 'm') for (let i = 0; i < args.length; i++) {
      if (args[i] === 0 || args[i] === 49) background = null;
      else if (args[i] === 48 && args[i + 1] === 5) { background = args[i + 2]; i += 2; }
    }
    if (command === 'K' || command === 'J') erase.push({ command, background });
  }
  return { erase, printable, background };
}

test('chat turns keep compact native input and retain a grey submitted user row', async t => {
  const f = tty(t, { columns: 40, env: {} }); f.terminal.identify(identity, ['fixture']);
  const before = f.stderr;
  const answer = f.terminal.ask('❯ ', new AbortController().signal, true);
  const prompt = stripVTControlCharacters(f.stderr.slice(before.length));
  assert.equal(prompt, '\n❯ ', 'no fixed-width rules or repeated metadata in the conversation');
  f.input.write('你好'); f.input.write('\r'); assert.equal(await answer, '你好');
  const submitted = f.stderr.slice(before.length), colors = terminalBackgrounds(submitted);
  assert.ok(colors.printable.filter(item => /[你好]/.test(item.text)).every(item => item.background === 236));
  assert.deepEqual(colors.erase.at(-1), { command: 'K', background: 236 }, 'only this input row is filled to the right');
  assert.equal(colors.background, null, 'the reply and next prompt cannot inherit the input background');
  assert.ok(colors.erase.filter(item => item.command === 'J').every(item => item.background === null), 'screen erase never paints a grey pane');
  assert.doesNotMatch(submitted, / {3,}/, 'background fill adds no wrapping spaces');
  f.terminal.beginTurn(); f.terminal.write('正常回复。\n'); f.terminal.finishTurn('completed');
  assert.doesNotMatch(f.stdout, /48;5;236/);
  const approvalStart = f.stderr.length;
  const approval = f.terminal.ask('Allow? ', new AbortController().signal);
  f.input.write('n\r'); assert.equal(await approval, 'n');
  assert.doesNotMatch(f.stderr.slice(approvalStart), /48;5;236/);
});

test('grey input preserves editing and never erases an exact-width final character', async t => {
  for (const line of ['abcdef', '中文中文']) {
    const f = tty(t, { columns: 8, env: {} });
    const answer = f.terminal.ask('❯ ', new AbortController().signal, true);
    f.input.write(line); const beforeEnter = f.stderr.length;
    f.input.write('\r'); assert.equal(await answer, line);
    if (line === 'abcdef') assert.doesNotMatch(f.stderr.slice(beforeEnter), /\x1b\[K/, 'full-width text must not lose its last glyph');
    assert.equal(terminalBackgrounds(f.stderr).background, null);
  }
  const f = tty(t, { columns: 32, env: {} });
  const answer = f.terminal.ask('❯ ', new AbortController().signal, true);
  f.input.write('first draft'); f.input.write('\x1b[D'); f.input.write('\x7f');
  f.status.columns = 20; f.status.emit('resize'); f.input.write('\r');
  assert.equal(await answer, 'first drat');
  assert.ok(terminalBackgrounds(f.stderr).erase.filter(item => item.command === 'J').every(item => item.background === null));
});

test('plain terminal input stays undecorated with NO_COLOR', async t => {
  const f = tty(t), answer = f.terminal.ask('❯ ', new AbortController().signal, true);
  f.input.write('plain input\r'); assert.equal(await answer, 'plain input');
  assert.doesNotMatch(f.stderr, /48;5;236|─{2,}|Tab complete/);
});

test('native header and clipping fit Chinese, emoji and narrow terminals by display cells', () => {
  assert.equal(terminalWidth('中文 👩🏽‍💻 é 🇨🇳'), 12);
  for (const columns of [20, 32, 80, 130]) {
    const header = stripVTControlCharacters(chatHeader(identity, columns, true));
    const box = header.split('\n').filter(line => /^[╭│╰]/.test(line));
    assert.ok(box.length > 5);
    assert.ok(box.every(line => terminalWidth(line) <= columns - 1), header);
    assert.equal(new Set(box.map(terminalWidth)).size, 1, 'all edges align');
    assert.ok(!terminalClip(identity.workspace, columns).includes('\ufffd'));
    assert.ok(terminalWidth(terminalClip(identity.workspace, columns)) <= columns);
  }
});

test('English CLI chrome and paste markers preserve the original non-English conversation', t => {
  const f = tty(t);
  f.terminal.identify({ ...identity, workspace: '/work' }, ['fixture']);
  f.terminal.beginTurn(); f.terminal.write('继续检查项目。\n'); f.terminal.finishTurn('completed');
  assert.match(stripVTControlCharacters(f.stderr), /Working in the current directory/);
  assert.match(stripVTControlCharacters(f.stderr), /✓ Completed/);
  assert.doesNotMatch(f.stderr, /\p{Script=Han}/u);
  assert.equal(stripVTControlCharacters(f.stdout).trim(), '继续检查项目。');
  const pastes = new ChatPastes();
  for (const value of ['中文'.repeat(600), '第一行\n第二行']) {
    const marker = pastes.add(value);
    assert.match(marker, /^\[Paste \d+ · \d+ lines? · \d+ chars\]$/);
    assert.doesNotMatch(marker, /\p{Script=Han}/u);
    assert.equal(pastes.expand(marker), value);
  }
});

test('Markdown survives split bold, links, code and fences without rewriting transcript rows', () => {
  const text = '# 标题\n**粗体** 与 `a**b`，看 [文件](C:/work/file.ts)。\n```ts\nconst value = "**literal**";\n```\n- 完成\n';
  let normal = '', split = '';
  const a = new ChatMarkdown(text => { normal += text; }, true), b = new ChatMarkdown(text => { split += text; }, true);
  a.write(text); a.end();
  for (const char of text) { b.write(char); b.flush(false); } b.end();
  assert.equal(stripVTControlCharacters(split), stripVTControlCharacters(normal));
  assert.match(split, /const value = "\*\*literal\*\*"/);
  assert.match(split, /C:\/work\/file.ts/);
  assert.doesNotMatch(split, /\x1b\[(?:\?1049|2J|\d*A)/);
});

test('unterminated or malicious model output flushes safely on stop', () => {
  let output = ''; const markdown = new ChatMarkdown(text => { output += text; }, true);
  markdown.write('\x1b[2J\x1b]52;c;secret\x07**unfinished'); markdown.end();
  assert.equal(stripVTControlCharacters(output).trim(), '**unfinished');
  assert.doesNotMatch(output, /\x1b\[2J|52;c/);
});

function renderMarkdown(text, { columns = 80, split = false } = {}) {
  let output = '';
  const renderer = new ChatMarkdown(text => { output += text; }, true, () => columns);
  if (split) for (const char of text) { renderer.write(char); renderer.flush(false); }
  else renderer.write(text);
  renderer.end();
  return stripVTControlCharacters(output);
}

const toolTable = [
  '文件与代码', '', '| 工具 | 用途 |', '| --- | --- |',
  '| `read_file` / `write_file` / `edit_file` | 读取、新建、按精确匹配或行号修改文件 |',
  '| `apply_patch` | 一次性提交多文件关联改动（带校验与回滚） |',
  '| `search_file_content` | 在项目/文件内容里做文本搜索 |',
  '| `remember_file` / `read_file_memos` | 记录和取回文件备注与下载链接 |', '',
  '命令与进程',
].join('\n');

test('Markdown tables render aligned borders and wrapped cells across streaming chunks and terminal widths', () => {
  for (const columns of [38, 66, 100, 180]) {
    const output = renderMarkdown(toolTable, { columns });
    assert.equal(renderMarkdown(toolTable, { columns, split: true }), output);
    assert.match(output, /╭─+┬─+╮/); assert.match(output, /╰─+┴─+╯/);
    assert.doesNotMatch(output, /\| ---|\| 工具/);
    assert.ok(output.split('\n').every(line => terminalWidth(line) <= Math.min(columns - 2, 104)), output);
    const tableRows = output.split('\n').filter(line => /^  [╭├╰│]/.test(line));
    assert.equal(new Set(tableRows.map(terminalWidth)).size, 1, 'ANSI and full-width glyphs do not shift column borders');
    const firstColumn = tableRows.filter(line => line.startsWith('  │')).map(line => line.split('│')[1]).join('').replace(/\s/g, '');
    for (const name of ['read_file', 'write_file', 'edit_file', 'apply_patch', 'search_file_content', 'remember_file', 'read_file_memos']) {
      assert.ok(firstColumn.includes(name), name + ' is never truncated');
    }
    assert.match(output, /文件与代码\n\n  ╭/);
    assert.match(output, /╯\n\n  命令与进程/);
  }
});

test('table cell parsing keeps escaped pipes, inline code, links, graphemes, alignment and explicit breaks', () => {
  const source = '| Name | Amount | Status |\n| :--- | ---: | :---: |\n' +
    '| **A** \\| B | 12 | `ready|idle` |\n' +
    '| 👩🏽‍💻 é 🇨🇳 | 3 | [doc](https://x.test)<br>next |';
  let styled = ''; const renderer = new ChatMarkdown(text => { styled += text; }, true, () => 90);
  renderer.write(source); renderer.end();
  const plain = stripVTControlCharacters(styled);
  assert.equal(renderMarkdown(source, { columns: 90, split: true }), plain);
  assert.match(plain, /A \| B/); assert.match(plain, /ready\|idle/);
  assert.match(plain, /👩🏽‍💻 é 🇨🇳/); assert.doesNotMatch(plain, /<br>|\ufffd/);
  assert.ok(plain.replace(/[\s│]/g, '').includes('doc(https://x.test)next'));
  const row = plain.split('\n').find(line => line.includes('A | B')).split('│');
  assert.ok(row[1].startsWith(' A | B')); assert.match(row[2], /^ +12 $/);
  assert.ok(Math.abs(row[3].match(/^ */)[0].length - row[3].match(/ *$/)[0].length) <= 1, 'centered cells have balanced padding');
  assert.match(styled, /\x1b\[36mready\|idle\x1b\[0m/);
  assert.doesNotMatch(styled, /\x1b\[(?:\?1049|2J|\d*A)/);
});

test('tables without outer pipes and uneven data rows retain every field', () => {
  const source = '`Name` | Value\n:--- | ---:\nfirst | one\nsecond | two | extra\nthird |\n';
  const output = renderMarkdown(source, { columns: 80 });
  assert.match(output, /╭─+┬─+╮/); assert.match(output, /first/);
  assert.match(output, /two \| extra/); assert.match(output, /third/);
  let streamed = ''; const renderer = new ChatMarkdown(text => { streamed += text; }, false);
  renderer.write('`Name` | Value\n');
  for (const char of source.slice('`Name` | Value\n'.length)) { renderer.write(char); renderer.flush(false); }
  renderer.end(); assert.equal(streamed, output);
});

test('narrow multi-column tables expand by field instead of losing content', () => {
  const source = '| Name | Result | Count |\n| --- | --- | ---: |\n| alpha | completed | 12 |\n| beta | pending | 3 |';
  const output = renderMarkdown(source, { columns: 24, split: true });
  assert.match(output, /Name: alpha\n/); assert.match(output, /Result: completed/);
  assert.match(output, /Count: 12\n\n  Name: beta/);
  assert.ok(output.split('\n').every(line => terminalWidth(line) <= 22), output);
  assert.doesNotMatch(output, /\| ---|…/);
});

test('table lookahead preserves ordinary pipes, incomplete tables and literal fenced examples', () => {
  const prose = 'Run `left | right`.\nA | B\nnot a delimiter\n';
  const output = renderMarkdown(prose, { split: true });
  assert.doesNotMatch(output, /┬|┼/); assert.match(output, /left \| right/); assert.match(output, /A \| B/);
  for (const source of ['| A | B |', '| A | B |\n| -- |', '| A | B |\n| wrong | delimiter |']) {
    assert.doesNotMatch(renderMarkdown(source, { split: true }), /┬|┼/);
    assert.equal(renderMarkdown(source).replace(/\s/g, ''), source.replace(/\s/g, ''), 'unconfirmed headers remain literal');
  }
  const code = '| A | B |\n| --- | --- |\n| x | y |\n';
  assert.ok(renderMarkdown('```md\n' + code + '```', { split: true }).includes(code.replace(/^/gm, '  ').trimEnd()));
  const headerOnly = renderMarkdown('| A | B |\n| --- | --- |', { split: true });
  assert.match(headerOnly, /╭─+┬─+╮/); assert.match(headerOnly, /╰─+┴─+╯/);
});

test('tables stream complete rows before the turn ends and resize only future output', () => {
  let output = '', columns = 90;
  const renderer = new ChatMarkdown(text => { output += text; }, false, () => columns);
  renderer.write('| Name | Details | Count |\n| --- | --- | ---: |\n| alpha | first completed row | 10 |\n');
  assert.match(output, /alpha/); assert.match(output, /first completed row/);
  const committed = output;
  columns = 24;
  renderer.write('| beta | later content | 20 |\n'); renderer.end();
  assert.equal(output.slice(0, committed.length), committed);
  const following = output.slice(committed.length);
  assert.match(following, /Name: beta/);
  assert.ok(following.split('\n').every(line => terminalWidth(line) <= 22), following);
  assert.doesNotMatch(output, /\x1b\[/);
});

test('dense tool lists gain spacing, hanging indents and complete identifiers at terminal widths', () => {
  const tools = ['read_file', 'write_file', 'edit_file', 'apply_patch', 'search_file_content',
    'terminal_exec', 'terminal_list', 'terminal_poll', 'terminal_write', 'terminal_stop'];
  const source = '我当前可用的工具大致分为以下几类：\n' +
    '- **文件与代码**：读取文件 `read_file`、写入文件 `write_file`、精确编辑 `edit_file`、补丁式修改 `apply_patch`、内容搜索 `search_file_content`\n' +
    '- **终端命令**：执行命令 `terminal_exec`，以及查看、读取输出、写入输入、停止终端的 `terminal_list`、`terminal_poll`、`terminal_write`、`terminal_stop`\n\n' +
    '这些工具会受到权限及项目配置的影响。';
  for (const columns of [38, 66, 100, 180]) {
    const output = renderMarkdown(source, { columns });
    assert.equal(renderMarkdown(source, { columns, split: true }), output, 'provider chunk boundaries must not change layout');
    assert.ok(output.split('\n').every(line => terminalWidth(line) <= Math.min(columns - 2, 104)), output);
    for (const name of tools) assert.equal(output.split(name).length, 2, `identifier stays whole and occurs once: ${name}`);
    assert.match(output, /以下几类：\n\n  • 文件与代码/);
    assert.match(output, /search_file_content\n\n  • 终端命令/);
    assert.match(output, /terminal_stop\n\n  这些工具/);
    const listRows = output.slice(output.indexOf('  •'), output.indexOf('\n\n  这些工具')).split('\n');
    assert.ok(listRows.filter(line => line && !line.startsWith('  •')).every(line => line.startsWith('    ')), 'wrapped content aligns with its item');
    assert.equal(output.replace(/[\s•]/g, ''), source.replace(/\*\*|`|^- /gm, '').replace(/\s/g, ''), 'all original text survives reflow');
  }
});

test('nested and numbered lists, paragraphs and headings keep their hierarchy without accumulating blank rows', () => {
  const source = '## 操作步骤\n1. 检查现有文件，然后再执行修改。\n   - 先读取配置\n   - 再检查日志\n2. 执行离线测试并确认结果。\n\n\n\n最后一段。';
  const output = renderMarkdown(source, { columns: 38, split: true });
  assert.match(output, /^  操作步骤\n\n  1\. /);
  assert.match(output, /\n     • 先读取配置\n\n     • 再检查日志\n\n  2\. /);
  assert.match(output, /\n\n  最后一段。\n\n$/);
  assert.doesNotMatch(output, /\n{3,}/);
  assert.equal(output, renderMarkdown(source, { columns: 38 }));
});

test('streamed prose handles CJK, emoji, long words, links and quotes without dropping characters', () => {
  const source = '> 这里是 👩🏽‍💻 与 é 和 🇨🇳，请查看 [详细说明](https://example.test/a_long_path)。\n\n' +
    '`' + 'tool_'.repeat(500) + '`\n\n' +
    '**重要说明**：\n（完整信息）不会被省略。';
  for (const columns of [20, 40, 90]) {
    const output = renderMarkdown(source, { columns });
    assert.equal(renderMarkdown(source, { columns, split: true }), output);
    assert.ok(output.split('\n').every(line => terminalWidth(line) <= columns - 2), output);
    assert.match(output, /👩🏽‍💻/); assert.match(output, /é/); assert.match(output, /🇨🇳/);
    assert.equal(output.replace(/\s/g, '').match(/tool_/g).length, 500);
    assert.match(output.replace(/[\s│]/g, ''), /https:\/\/example\.test\/a_long_path/);
    assert.doesNotMatch(output, /\ufffd/);
  }
});

test('fenced code preserves exact indentation, tabs, blank lines and long lines', () => {
  const code = '\tconst sample = "**literal**";\n\n    ' + 'x'.repeat(120) + '\n';
  const source = '运行下面的示例：\n```ts\n' + code + '```\n结束。';
  const output = renderMarkdown(source, { columns: 38 });
  assert.equal(output, renderMarkdown(source, { columns: 38, split: true }));
  const displayedCode = output.split('  ╭─ ts\n')[1].split('  ╰─\n')[0];
  assert.equal(displayedCode.replace(/^  /gm, ''), code, 'code uses native soft wrap, not prose reflow');
  assert.match(output, /  ╰─\n\n  结束。/);
  const inline = '执行 `printf "a  b"`，然后检查。';
  assert.match(renderMarkdown(inline, { columns: 38, split: true }), /printf "a  b"/);
  assert.equal(renderMarkdown(inline, { columns: 38, split: true }), renderMarkdown(inline, { columns: 38 }));
});

test('streaming remains visible before completion, resize affects new rows, and completion is separated', async t => {
  const f = tty(t, { columns: 70, env: {} });
  f.terminal.beginTurn(); f.terminal.write('正在检查当前文件，这段回复会逐步出现。');
  await delay(110);
  assert.match(stripVTControlCharacters(f.stdout), /正在检查当前文件/);
  const committed = f.stdout;
  f.output.columns = 38; f.status.columns = 38; f.status.emit('resize');
  assert.equal(f.stdout, committed, 'completed rows are never rewritten');
  f.terminal.write('\n\n- 读取 `search_file_content` 并检查全部结果，继续完成剩余工作。');
  f.terminal.event(event('assistant_segment_completed', {})); f.terminal.finishTurn('completed');
  const output = stripVTControlCharacters(f.stdout);
  assert.match(output, /search_file_content/);
  assert.ok(output.slice(output.indexOf('  •')).trimEnd().split('\n').every(line => terminalWidth(line) <= 36));
  assert.ok(output.endsWith('\n\n'), 'completion status starts after a blank row');
  assert.doesNotMatch(f.stdout, /\x1b\[(?:\?1049|2J|\d*A)/);
});

test('command, model and confirmation completion each use their actual input choices', () => {
  const models = ['first', 'second'].map(id => ({ id, modelName: id }));
  assert.deepEqual(commandSuggestions('/mo', 3, models).items.map(item => item.value), ['/model ']);
  assert.deepEqual(commandSuggestions('/model se', 9, models).items.map(item => item.value), ['second']);
  assert.equal(commandSuggestions('explain /mo', 11, models), undefined, 'embedded examples are not local commands');
  assert.deepEqual(choiceSuggestions('/ca', 3, [{ value: '/cancel' }]).items.map(item => item.value), ['/cancel']);
  assert.deepEqual(choiceSuggestions('2', 1, [{ value: 'id-2-first', label: '1. First' }, { value: 'second', label: '2. Second' }]).items.map(item => item.value), ['second']);
});

test('slash completion matches consecutive characters from the command start and prioritizes exact names', () => {
  const extra = [{ value: '/video:edit ', label: '/edit', description: 'Edit' }, { value: '/editor ' }, { value: '/edit ' }];
  const values = text => commandSuggestions(text, text.length, [], extra).items.map(item => item.value);
  assert.deepEqual(values('/e'), ['/exit', '/editor ', '/edit ']);
  assert.deepEqual(values('/ex'), ['/exit']);
  assert.deepEqual(values('/edit'), ['/edit ', '/editor ']);
  assert.deepEqual(values('/vi'), ['/video:edit ']);
  assert.deepEqual(values('/video:e'), ['/video:edit ']);
  assert.deepEqual(values('/vd'), [], 'skipping characters is not a prefix match');
  assert.deepEqual(values('/od'), [], 'middle-of-name matches are excluded');
  assert.deepEqual(values('/q'), ['/q', '/quit']);
  assert.deepEqual(values('/quit'), ['/quit']);
  assert.deepEqual(values('/quit-now'), []);
  const draft = '  /e later text', hints = commandSuggestions(draft, 4, []);
  assert.deepEqual(applyChatSuggestion(draft, hints), { line: '  /exit later text', cursor: 7 });
});

function completionFixture(t, platform = 'linux') {
  const root = platform === 'win32' ? 'C:\\work' : '/work', separator = platform === 'win32' ? '\\' : '/';
  const path = name => root + separator + name.replaceAll('/', separator);
  const catalog = { pluginCommands: [{ id: 'video:edit', description: '剪辑视频', path: path('plugins/video/SKILL.md') }],
    skills: [{ name: 'notes', description: '整理笔记', path: path('skills/notes/SKILL.md') },
      { name: 'hidden', path: path('hidden/SKILL.md'), invocationMode: 'model' }] };
  const entries = [
    { name: 'src', path: path('src'), kind: 'folder' }, { name: 'Read Me.md', path: path('Read Me.md'), kind: 'file' },
    { name: 'other.txt', path: path('other.txt'), kind: 'file' },
  ];
  const calls = [];
  const client = { async call(operation, input) {
    calls.push({ operation, input });
    if (operation === 'conversation.catalog') return catalog;
    assert.equal(operation, 'files.list', 'completion cannot read content or execute tools');
    assert.equal(input.sessionId, 'session-first');
    if (input.directoryPath === path('blocked')) throw new Error('Directory link points outside workspace');
    assert.ok([root, path('src')].includes(input.directoryPath), input.directoryPath);
    return { entries: input.directoryPath === root ? entries : [{ name: 'index.ts', path: path('src/index.ts'), kind: 'file' }] };
  } };
  const engine = new AgentChatCompletion(client, { workspace: root, sessionId: 'session-first', platform,
    models: [{ id: 'id-first', modelName: 'First Model' }, { id: 'id-second', modelName: 'Second Model' }] });
  t.after(() => engine.close());
  const suggest = line => engine.suggest(line, line.length, new AbortController().signal);
  return { engine, suggest, path, calls, catalog };
}

test('slash hints include the actual Agent catalog and preserve plugin invocation versus ordinary Skill references', async t => {
  const f = completionFixture(t), choices = await f.suggest('/');
  assert.ok(choices.items.some(item => item.value === '/video:edit '));
  assert.ok(choices.items.some(item => item.value === '/notes '));
  assert.ok(!choices.items.some(item => item.value.includes('hidden')));
  assert.deepEqual((await f.suggest('/e')).items.map(item => item.value), ['/exit'], 'remote catalog uses the same prefix filter as local hints');
  assert.deepEqual((await f.suggest('/q')).items.map(item => item.value), ['/q', '/quit']);
  assert.deepEqual((await f.suggest('/model Second')).items.map(item => item.value), ['id-second']);
  assert.equal((await f.engine.prepare('/video:edit 按原要求处理', new AbortController().signal)).text, '/video:edit 按原要求处理');
  const prepared = await f.engine.prepare('/notes 记录内容', new AbortController().signal);
  assert.equal(prepared.text, '[notes](</work/skills/notes/SKILL.md>) 记录内容');
  assert.equal(prepared.userMessageMetadata.composerReferenceContent, '/notes 记录内容');
  assert.equal(f.calls.filter(call => call.operation === 'conversation.catalog').length, 1, 'rapid hints share the catalog cache');
});

test('at mentions and paths complete inside sentences, with quoted names and the remote platform path rules', async t => {
  for (const platform of ['linux', 'win32']) {
    const f = completionFixture(t, platform);
    const line = '请检查 @Re 以及后面的说明', cursor = line.indexOf(' 以及');
    const hints = await f.engine.suggest(line, cursor, new AbortController().signal);
    const applied = applyChatSuggestion(line, hints);
    assert.equal(applied.line, '请检查 @"Read Me.md" 以及后面的说明');
    assert.match((await f.suggest('请检查 @src/')).items[0].value, /^@src\/index.ts /);
    assert.match((await f.suggest('检查 ./src/')).items[0].value, /^\.\/src\/index.ts /);
    assert.equal(await f.suggest('mail@example.test'), undefined);
    assert.equal(await f.suggest('https://example.test/a'), undefined);
    const calls = f.calls.length;
    assert.equal((await f.suggest('@../')).items.length, 0);
    assert.equal(f.calls.length, calls, 'outside-workspace hints never issue a directory query');
    assert.equal((await f.suggest('@blocked/')).items.length, 0, 'server path protection stays authoritative');
    const prepared = await f.engine.prepare('请检查 @"Read Me.md" 和 @src/index.ts，邮箱 mail@example.test\n`@other.txt`\n```text\n@other.txt\n```', new AbortController().signal);
    assert.deepEqual(prepared.files, [f.path('Read Me.md'), f.path('src/index.ts')], 'explicit references accept adjacent punctuation, but code and emails never attach');
    const many = await f.engine.prepare('@src/index.ts @"Read Me.md" @src/ @"Read Me.md"', new AbortController().signal);
    assert.deepEqual(many.files, [f.path('src/index.ts'), f.path('Read Me.md')], 'directories stay text, duplicate file references are collapsed');
  }
});

test('hints appear while typing; arrows choose and Tab fills without submitting the command', async t => {
  const f = tty(t, { env: {} });
  let submitted = false;
  const answer = f.terminal.ask('❯ ', new AbortController().signal, true).then(value => { submitted = true; return value; });
  f.input.write('/'); await delay(90);
  assert.match(stripVTControlCharacters(f.stderr), /Switch the session model/);
  assert.match(stripVTControlCharacters(f.stderr), /Tab complete/);
  f.input.write('\x1b[B'); f.input.write('\t'); await tick();
  assert.equal(submitted, false);
  f.input.write('\r'); assert.equal(await answer, '/settings');
  assert.ok(terminalBackgrounds(f.stderr).erase.filter(item => item.command === 'J').every(item => item.background === null));
  assert.doesNotMatch(f.stderr, /\x1b\[\?1049|\x1b\[2J/);
});

test('typing /e offers only the exit prefix and Tab keeps an exact /q intact', async t => {
  const f = tty(t);
  let answer = f.terminal.ask('❯ ', new AbortController().signal, true);
  f.input.write('/e'); await delay(90);
  assert.match(stripVTControlCharacters(f.stderr), /\/exit/);
  assert.doesNotMatch(stripVTControlCharacters(f.stderr), /\/model|\/settings|\/help/);
  f.input.write('\t'); await tick(); f.input.write('\r'); assert.equal(await answer, '/exit');
  answer = f.terminal.ask('❯ ', new AbortController().signal, true);
  f.input.write('/q'); f.input.write('\t'); await tick(); f.input.write('\r'); assert.equal(await answer, '/q');
});

test('Tab fills model and approval choices globally, but Enter submits only the actual input', async t => {
  const f = tty(t);
  let answer = f.terminal.ask('Model? ', new AbortController().signal, { choices: [{ value: 'id-first', label: 'First' }, { value: 'id-second', label: 'Second' }] });
  f.input.write('Sec'); f.input.write('\t'); await tick(); f.input.write('\r'); assert.equal(await answer, 'id-second');
  answer = f.terminal.ask('Allow? ', new AbortController().signal, { choices: [{ value: 'n' }, { value: 'y' }] });
  await delay(90); f.input.write('\r'); assert.equal(await answer, '', 'a displayed choice is never automatically approved');
  answer = f.terminal.ask('Allow? ', new AbortController().signal, { choices: [{ value: 'n' }, { value: 'y' }] });
  f.input.write('y'); f.input.write('\t'); await tick(); f.input.write('\r'); assert.equal(await answer, 'y');
});

test('a late remote completion cannot replace a newer draft or answer the next approval', async t => {
  const f = tty(t); let resolve;
  f.terminal.setSuggestionSource(() => new Promise(done => { resolve = done; }));
  const first = f.terminal.ask('❯ ', new AbortController().signal, true);
  f.input.write('@sl'); f.input.write('\t'); await tick();
  f.input.write('ow\r'); assert.equal(await first, '@slow', 'pending completion never blocks native input');
  const next = f.terminal.ask('Allow? ', new AbortController().signal, { choices: [{ value: 'n' }, { value: 'y' }] });
  resolve({ start: 0, end: 3, items: [{ value: 'y' }] }); await tick();
  f.input.write('n\r'); assert.equal(await next, 'n');
});

test('file completion replaces only the token at the caret and preserves the rest of the draft', async t => {
  const f = tty(t), c = completionFixture(t); f.terminal.setSuggestionSource(c.engine.suggest);
  const answer = f.terminal.ask('❯ ', new AbortController().signal, true);
  f.input.write('检查 @Re 后文'); f.input.write('\x1b[D\x1b[D\x1b[D');
  f.input.write('\t'); await delay(20); f.input.write('\r');
  assert.equal(await answer, '检查 @"Read Me.md" 后文');
});

test('resizing/removing hints preserves the draft and pasted Tabs do not select candidates', async t => {
  const f = tty(t, { columns: 32 });
  const answer = f.terminal.ask('❯ ', new AbortController().signal, true);
  f.input.write('/'); await delay(90); f.status.columns = 20; f.status.emit('resize');
  f.input.write('\x1b[200~notes\twith\ntext\x1b[201~'); await tick();
  f.input.write('\r'); assert.equal(await answer, '/notes\twith\ntext');
  const before = f.stderr; await delay(100);
  assert.equal(f.stderr, before, 'no stale footer is drawn after submission');
});

test('multiline paste stays folded until Enter, with full content restored in one message', async t => {
  const f = tty(t); f.terminal.identify(identity, ['fixture']);
  let settled = false;
  const answer = f.terminal.ask('❯ ', new AbortController().signal, true).then(value => { settled = true; return value; });
  const text = '第一行\n/model second\n最后一行';
  const bytes = Buffer.from('\x1b[200~' + text + '\x1b[201~');
  for (let index = 0; index < bytes.length; index++) f.input.write(bytes.subarray(index, index + 1));
  await tick(); assert.equal(settled, false); assert.match(f.stderr, /\[Paste 1 · 3 lines/);
  assert.doesNotMatch(f.stderr, /最后一行/);
  f.input.write('\r'); assert.equal(await answer, text);
  const next = f.terminal.ask('❯ ', new AbortController().signal, true);
  f.input.write('\x1b[A\r'); assert.equal(await next, text, 'native history retains the paste value');
});

test('unbracketed multi-line paste does not submit commands; normal one-line Enter still submits', async t => {
  const f = tty(t);
  const answer = f.terminal.ask('❯ ', new AbortController().signal, true);
  f.input.write('line one\n/exit\n'); await tick();
  assert.match(f.stderr, /Paste/);
  f.input.write('\r'); assert.equal(await answer, 'line one\n/exit\n');
  const next = f.terminal.ask('❯ ', new AbortController().signal, true);
  f.input.write('ordinary message\n'); assert.equal(await next, 'ordinary message');
});

test('late typing and a paste begun during execution never answer the next approval', async t => {
  const f = tty(t); f.terminal.beginTurn();
  f.input.write('y\n\x1b[200~y');
  let settled = false;
  const answer = f.terminal.ask('Allow? [y/N]: ', new AbortController().signal).then(value => { settled = true; return value; });
  f.input.write('\n\x1b[201~'); await tick(); assert.equal(settled, false);
  f.input.write('n\r'); assert.equal(await answer, 'n');
  f.terminal.finishTurn('completed');
});

test('a paste interrupted with its prompt cannot spill into a later approval', async t => {
  for (const partial of ['\x1b[200~y', '\x1b[20']) {
    const f = tty(t), abort = new AbortController();
    const chat = f.terminal.ask('❯ ', abort.signal, true);
    f.input.write(partial); abort.abort(); assert.equal(await chat, null);
    let settled = false;
    const approval = f.terminal.ask('Allow? ', new AbortController().signal).then(value => { settled = true; return value; });
    f.input.write(partial.endsWith('y') ? '\x1b[201~' : '0~y\x1b[201~'); await tick();
    assert.equal(settled, false);
    f.input.write('n\r'); assert.equal(await approval, 'n');
  }
});

test('approval answers do not pollute chat history, and Tab continues through readline', async t => {
  const f = tty(t); f.terminal.identify(identity, ['first', 'second']);
  let answer = f.terminal.ask('❯ ', new AbortController().signal, true);
  f.input.write('chat text\r'); assert.equal(await answer, 'chat text');
  answer = f.terminal.ask('Allow? ', new AbortController().signal);
  f.input.write('y\r'); assert.equal(await answer, 'y');
  answer = f.terminal.ask('❯ ', new AbortController().signal, true);
  f.input.write('\x1b[A\r'); assert.equal(await answer, 'chat text');
  answer = f.terminal.ask('❯ ', new AbortController().signal, true);
  f.input.write('/model se'); f.input.write('\t'); await tick(); f.input.write('\r'); assert.equal(await answer, '/model second');
});

test('App and CLI share failure interpretation, and returned errors are never rendered as success', t => {
  const f = tty(t), payload = { toolCallId: 'tool', toolName: 'mcp_call', display: { title: '读取素材' },
    resultError: { kind: 'tool', code: 'broken', message: '文件不可用' } };
  assert.equal(runtimeToolLifecycle(event('tool_returned', payload)).state, 'failed');
  f.terminal.beginTurn(); f.terminal.event(event('tool_running', payload));
  f.terminal.event(event('tool_returned', payload)); f.terminal.event(event('tool_returned', payload));
  f.terminal.finishTurn('completed');
  assert.match(f.stderr, /\[Tool failed\] 读取素材: 文件不可用/);
  assert.doesNotMatch(f.stderr, /✓ 读取素材/);
  assert.match(f.stderr, /1 tool call · 1 failure/);
});

test('execution clock comes from Runtime start/end, excluding queue delay and reconnect time', t => {
  const f = tty(t); f.terminal.beginTurn();
  f.terminal.event(event('turn_accepted', { status: 'accepted' }, '2026-10-22T02:58:00Z'));
  f.terminal.event(event('turn_started', { status: 'running' }, '2026-10-22T03:00:00Z'));
  f.terminal.event(event('turn_terminal', { status: 'completed' }, '2026-10-22T03:00:07Z'));
  f.terminal.finishTurn('completed');
  assert.match(f.stderr, /✓ Completed · 7\.0s/);
  assert.doesNotMatch(f.stderr, /127\.0s/);
});

test('redirected stdout retains Markdown while terminal progress, resize and shutdown stay separate', async t => {
  const f = tty(t, { stdout: false });
  const source = '**原始 Markdown**\n| Name | Value |\n| --- | --- |\n| x | y |\n';
  f.terminal.beginTurn(); f.terminal.write(source);
  f.status.columns = 30; f.status.emit('resize'); await delay(140);
  f.terminal.finishTurn('completed'); f.terminal.close();
  assert.equal(f.stdout, source);
  assert.match(f.stderr, /\x1b\[\?2004h/); assert.ok(f.stderr.endsWith('\x1b[?2004l'));
  assert.equal(f.input.raw, false); assert.equal(f.input.listenerCount('data'), 0);
  assert.doesNotMatch(f.stderr, /\x1b\[\?1049|\x1b\[2J/);
});

test('resizing streamed output never makes readline erase a committed reply', async t => {
  const f = tty(t); f.terminal.beginTurn();
  f.terminal.write('这段回复正在流式显示'); await delay(100);
  const before = f.stderr;
  f.status.columns = 20; f.status.emit('resize');
  assert.equal(f.stderr, before, 'no active prompt/status owns the cursor during a reply');
  f.terminal.write('\n'); f.terminal.event(event('assistant_segment_completed', {}));
  f.status.columns = 10; f.status.emit('resize');
  assert.doesNotMatch(f.stderr, /\x1b\[2J|\x1b\[\?1049/);
  f.terminal.finishTurn('completed');
});

test('plan progress stays compact and explicit inspection retains every step', t => {
  const f = tty(t), plan = { protocol: 'bush.task_plan.v1', planId: 'fixture', active: true, nodes: [
    { step: '读取项目', status: 'completed' }, { step: '修改界面', status: 'in_progress' }, { step: '离线验证', status: 'pending' },
  ] };
  f.terminal.plan(plan); f.terminal.plan(plan);
  assert.equal(f.stderr.match(/Plan 1\/3/g).length, 1); assert.doesNotMatch(f.stderr, /读取项目|离线验证/);
  f.terminal.plan(plan, true); assert.match(f.stderr, /✓ 1\. 读取项目/); assert.match(f.stderr, /○ 3\. 离线验证/);
});

test('a dumb terminal still accepts sequential prompts and exits without ANSI', async t => {
  const original = process.env.TERM; process.env.TERM = 'dumb';
  try {
    const f = tty(t, { env: { TERM: 'dumb' } });
    const first = f.terminal.ask('第一题: ', new AbortController().signal);
    f.input.write('first\r'); assert.equal(await first, 'first');
    const second = f.terminal.ask('第二题: ', new AbortController().signal);
    f.input.write('second\r'); assert.equal(await second, 'second');
    f.terminal.close(); assert.doesNotMatch(f.stderr, /\x1b/);
  } finally { process.env.TERM = original; }
});

test('oversized or unfinished paste is bounded and cannot leak a partial submission', () => {
  let forwarded = '', pasted = '', rejected = 0;
  const decoder = new ChatPasteDecoder(text => { forwarded += text; }, text => { pasted += text; }, () => { rejected++; }, () => true);
  decoder.feed('\x1b[200~' + 'x'.repeat(1_000_001)); decoder.feed('\n/exit\x1b[201~');
  assert.equal(rejected, 1); assert.equal(forwarded, ''); assert.equal(pasted, '');
  decoder.feed('\x1b[200~unfinished'); decoder.close(); assert.equal(pasted, '');
  decoder.feed('next\r'); assert.equal(forwarded, 'next\r');
});
