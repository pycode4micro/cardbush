import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { stripVTControlCharacters } from 'node:util';
import { AgentChatReferences, downloadChatArtifact } from '../dist-electron/agentChatReferences.mjs';
import { chatLinkTarget, markdownLinkAt, terminalHyperlink, terminalSupportsHyperlinks } from '../dist-electron/agentChatLinks.mjs';
import { ChatMarkdown, terminalWidth } from '../dist-electron/agentChatPresentation.mjs';

const signal = () => new AbortController().signal;
const scope = { sessionId: 'session', turnId: 'turn', workspace: 'C:\\work', platform: 'win32', local: true, hyperlinks: true };
const sourceRef = 'cardbush-source:v2:2:22-aaaaaaaaaaaaaaaa';
function fixture(answers = {}) {
  const calls = [], opened = [], io = { output: '', draft: '', status(text) { this.output += text; }, restoreDraft(text) { this.draft = text; } };
  const client = { async call(operation, input) {
    calls.push({ operation, input });
    if (operation === 'runtime.command') {
      if (input.kind in answers) return typeof answers[input.kind] === 'function' ? answers[input.kind](input.payload) : answers[input.kind];
      if (input.kind === 'runtime.list_turn_events' || input.kind === 'runtime.list_turn_tool_executions') return [];
    }
    assert.fail(`Unexpected operation: ${operation} ${input.kind}`);
  } };
  const references = new AgentChatReferences(client, io, async (target, kind) => { opened.push({ target, kind }); });
  references.setScope(scope);
  return { references, calls, io, opened, client };
}

test('file targets preserve Windows spaces, Unicode, escaped punctuation and source locations', () => {
  const target = chatLinkTarget('/C:/work/中文 report (final).md:12:3', '', 'win32');
  assert.equal(target.target, 'C:\\work\\中文 report (final).md'); assert.equal(target.line, 12); assert.equal(target.column, 3);
  assert.equal(target.href, 'file:///C:/work/%E4%B8%AD%E6%96%87%20report%20(final).md');
  assert.equal(chatLinkTarget('src/a.ts#L25', 'C:\\work', 'win32').target, 'C:\\work\\src\\a.ts');
  assert.equal(chatLinkTarget('report.md:12', 'C:\\work', 'win32').line, 12);
  assert.equal(chatLinkTarget('file:///C:/work/My%20File.md', '', 'win32').target, 'C:\\work\\My File.md');
  assert.equal(chatLinkTarget('file:///C:/work/My%20File.md#L12', '', 'win32').line, 12);
  assert.equal(chatLinkTarget('file:///C:/work/file%23L12', '', 'win32').target, 'C:\\work\\file#L12');
  assert.equal(chatLinkTarget('100%.md', 'C:\\work', 'win32').target, 'C:\\work\\100%.md');
  assert.equal(chatLinkTarget('../out/a.pdf', '/work/project', 'linux').target, '/work/out/a.pdf');
  for (const value of ['javascript:alert(1)', 'javascript:123', 'command:run', 'command:1', 'data:text/plain,hello', '\x1b]8;;https://bad', '#chapter', '#L12', ':12', 'C:\\work\\x']) {
    assert.equal(chatLinkTarget(value, '/work', 'linux'), undefined, value);
  }
  assert.equal(chatLinkTarget('/remote/home/file.md', 'C:\\work', 'win32'), undefined);
});

test('Markdown destinations accept spaced and nested paths with titles without swallowing following text', () => {
  for (const [input, target] of [
    ['[中文](<C:/work/中文 file (final).md> "label") next', 'C:/work/中文 file (final).md'],
    ['[docs](https://example.test/a_(b)) next', 'https://example.test/a_(b)'],
    ['[a\\[b\\]](./report.md:12)', './report.md:12'],
  ]) { const link = markdownLinkAt(input, 0); assert.equal(link.target, target); assert.ok(!input.slice(0, link.end).includes(' next')); }
  assert.equal(markdownLinkAt('[docs](https://example.test/a_(b)', 0), undefined);
});

test('hyperlinks use only supported terminals and application-validated destinations', () => {
  assert.ok(terminalSupportsHyperlinks({ WT_SESSION: 'fixture' }));
  assert.ok(terminalSupportsHyperlinks({ TERM_PROGRAM: 'vscode' }));
  assert.equal(terminalSupportsHyperlinks({ TERM: 'dumb', WT_SESSION: 'fixture' }), false);
  assert.equal(terminalSupportsHyperlinks({}), false);
  assert.equal(terminalHyperlink('bad', 'command://run'), 'bad');
  assert.equal(terminalHyperlink('bad', 'https://x/\x1b]52;c;secret'), 'bad');
  assert.equal(stripVTControlCharacters(terminalHyperlink('link', 'https://example.test')), 'link');
});

test('split streamed links, citations and tables retain clickable labels with bounded line width', () => {
  const content = '> 引用 [说明](<C:/work/中文 file.md:7>)。\n> > Nested [site](https://example.test/a_(b))\n\n' +
    '依据[2][3]。 `literal [9]`\n\n| File | Source |\n| --- | --- |\n| [下载](<C:/work/result.pptx>) | [2] |\n';
  const render = split => {
    const f = fixture(); let output = '';
    const markdown = new ChatMarkdown(text => { output += text; }, true, () => 55, f.references);
    if (split) for (const char of content) { markdown.write(char); markdown.flush(false); }
    else markdown.write(content);
    markdown.end(); return { output, f };
  };
  const full = render(false), streamed = render(true);
  assert.equal(stripVTControlCharacters(streamed.output), stripVTControlCharacters(full.output));
  assert.match(full.output, /\x1b\]8;;file:\/\/\/C:\/work\//);
  const plain = stripVTControlCharacters(full.output);
  assert.match(plain, /│ │ Nested/); assert.doesNotMatch(plain, /cardbush-|https:\/\//);
  assert.deepEqual(full.f.references.choices('source').map(item => item.value), ['2', '3']);
  assert.equal(full.f.references.choices('artifact').length, 2);
  assert.ok(plain.split('\n').every(line => terminalWidth(line) <= 53));
});

test('inline code file paths become real links while ordinary code and unknown filenames stay text', async () => {
  const content = '文件：`C:\\Users\\fixture\\Desktop\\中文 hello%20world.txt`\n内容：`Hello, World!`\n' +
    '`unknown.txt`\n[`说明.md`](<C:/work/说明.md:12>)\n```text\nC:\\work\\literal.txt\n```\n';
  const f = fixture(); let output = '';
  const markdown = new ChatMarkdown(text => { output += text; }, true, () => 80, f.references);
  for (const char of content) { markdown.write(char); markdown.flush(false); }
  markdown.end();
  assert.match(output, /\x1b\]8;;file:\/\/\/C:\/Users\/fixture\/Desktop\/%E4%B8%AD%E6%96%87%20hello%2520world\.txt/);
  assert.match(output, /\x1b\[4;94m/);
  assert.doesNotMatch(output, /file:[^\x1b]*unknown|file:[^\x1b]*literal|file:[^\x1b]*Hello/);
  assert.doesNotMatch(stripVTControlCharacters(output), /`说明\.md`/);
  assert.equal(f.references.choices('artifact').length, 2);
  assert.equal(f.references.path('unknown.txt'), undefined);
  assert.ok(f.references.path('中文 hello%20world.txt').href.includes('%2520'));
  await f.references.handle('artifact', '1', signal());
  assert.deepEqual(f.opened, [{ target: 'C:\\Users\\fixture\\Desktop\\中文 hello%20world.txt', kind: 'file' }]);
});

test('inline file references retain explicit remote/open fallbacks and never make scripts executable hyperlinks', () => {
  const f = fixture();
  for (const target of ['C:/work/run.cmd', 'C:/work/run.py', 'C:/work/app.exe']) {
    const link = f.references.path(target);
    assert.equal(link.href, undefined); assert.match(link.text, /\[file \d+\]/);
  }
  f.references.link('one', 'C:/one/same.txt'); f.references.link('two', 'C:/two/same.txt');
  assert.equal(f.references.path('same.txt'), undefined, 'an ambiguous basename must not open the wrong file');
  f.references.setScope({ ...scope, turnId: 'remote', local: false });
  assert.deepEqual(f.references.path('C:/work/remote.txt'), { text: 'C:/work/remote.txt [file 1]' });
  f.references.setScope({ ...scope, turnId: 'plain', hyperlinks: false });
  assert.deepEqual(f.references.path('C:/work/plain.txt'), { text: 'C:/work/plain.txt [file 1]' });
  assert.deepEqual(f.calls, [], 'rendering a file must not read, download or open it');
  assert.deepEqual(f.opened, []);
});

test('opening canonical references does not reinterpret literal percent signs or line markers', async () => {
  const f = fixture({ 'runtime.resolve_file_memo': () => ({ status: 'available', memo: {
    protocol: 'bush.file_memo.v1', id: 'file_1', reference: 'cardbush-memo:1',
    file: { path: 'C:\\work\\literal%20name#L12.txt', name: 'literal%20name#L12.txt', size: 1, mtimeMs: 1 }, note: { purpose: 'File', points: [] },
  } }) });
  f.references.link('literal', 'file:///C:/work/literal%23L12');
  f.references.link('memo', 'cardbush-memo:1');
  await f.references.handle('artifact', '1', signal()); await f.references.handle('artifact', '2', signal());
  assert.deepEqual(f.opened, [{ target: 'C:\\work\\literal#L12', kind: 'file' }, { target: 'C:\\work\\literal%20name#L12.txt', kind: 'file' }]);
});

test('/artifact only lists this turn and reuses native receipts, not arbitrary tool prose or private resources', async () => {
  const identity = { sessionId: 'session', turnId: 'turn' };
  const summary = { ...identity, toolCall: { id: 't' }, outcome: 'returned', resultAvailable: true,
    workspaceChanges: [{ path: 'src/changed.ts', status: 'modified' }, { path: 'gone.txt', status: 'deleted' }] };
  const f = fixture({
    'runtime.list_turn_events': [{ ...identity, kind: 'assistant_segment_completed', payload: { content: '[Report](<C:/work/report.pdf>)\n```\n[not a file](C:/work/code.txt)\n```' } },
      { sessionId: 'other', turnId: 'turn', kind: 'assistant_segment_completed', payload: { content: '[other](C:/secret.txt)' } }],
    'runtime.list_turn_tool_executions': [summary],
    'runtime.get_tool_execution': { ...summary, result: { mcp: { name: 'mcp__fixture' }, result: {
      structuredContent: { artifacts: [{ path: 'C:/WORK/REPORT.pdf' }, { path: 'C:/work/deck.pptx' }] },
      content: [{ type: 'text', text: 'C:/unrelated.txt' }, { type: 'resource_link', uri: 'file:///C:/work/private.png', annotations: { audience: ['assistant'] } },
        { type: 'resource_link', uri: 'file:///C:/work/chart.svg', name: 'chart.svg' }],
    } } },
  });
  await f.references.handle('artifact', '', signal());
  assert.equal(f.references.choices('artifact').length, 4);
  assert.doesNotMatch(f.io.output, /secret|code.txt|gone.txt|unrelated|private/);
  assert.equal(f.io.draft, '/artifact '); assert.deepEqual(f.opened, []);
  const choice = f.references.suggest('/artifact ', 10); assert.equal(choice.items.length, 4);
  assert.equal(f.references.suggest('/artifact 1', 11).items.length, 4);
  await f.references.handle('artifact', '1', signal());
  assert.deepEqual(f.opened, [{ target: 'C:\\work\\report.pdf', kind: 'file' }]);
  await f.references.handle('artifact', '', signal());
  assert.equal(f.calls.filter(call => call.input.kind === 'runtime.get_tool_execution').length, 1);
  f.references.setScope({ ...scope, turnId: 'next' }); assert.equal(f.references.choices('artifact').length, 0);
});

test('/source uses host-confirmed identities, explains evidence changes and exposes recorded excerpts', async () => {
  const f = fixture({
    'runtime.resolve_source_references': [{ number: 2, reference: sourceRef }],
    'runtime.resolve_source_memo': { status: 'resolved', memo: { protocol: 'bush.source_memo.v1', reference: sourceRef,
      markdown: `[2](${sourceRef})`, explanation: 'The recorded implementation uses this branch.', createdAt: '2026-10-22T00:00:00Z',
      sources: [{ kind: 'file', target: 'C:/work/source.ts', label: 'source.ts', locator: { line: 12, endLine: 14 }, excerpt: 'recorded\nexcerpt' }] }, evidenceStatus: ['changed'] },
  });
  f.references.source(2);
  await f.references.handle('source', '2', signal());
  assert.match(f.io.output, /Why this conclusion/); assert.match(f.io.output, /line 12–14 · changed · \/artifact 1/);
  assert.match(f.io.output, /│ recorded\n  │ excerpt/);
  assert.deepEqual(f.calls.find(call => call.input.kind === 'runtime.resolve_source_references').input.payload, { sessionId: 'session', turnId: 'turn', numbers: [2] });
  assert.deepEqual(f.opened, []);
});

test('file memo identities stay scoped to the original turn and never open unavailable targets', async () => {
  const f = fixture({ 'runtime.resolve_file_memo': payload => {
    assert.equal(payload.reference, 'cardbush-memo:1'); assert.equal(payload.sessionId, 'session'); assert.equal(payload.turnId, 'turn');
    return { status: 'unresolved', reason: 'reference_not_found' };
  } });
  assert.equal(f.references.link('deck.pptx', 'cardbush-memo:1').text, 'deck.pptx [file 1]');
  await assert.rejects(f.references.handle('artifact', '1', signal()), /reference is unavailable/);
  assert.deepEqual(f.opened, []);
});

test('/artifact resolves short memo destinations without turning captions into file identities', async () => {
  for (const label of ['打开或下载 pelican-bicycle.html', '打开动画', 'other.html']) {
    const f = fixture({ 'runtime.resolve_file_memo': payload => {
      assert.equal(payload.reference, 'cardbush-memo:1');
      assert.equal(payload.fileName, undefined);
      return { status: 'available', memo: { protocol: 'bush.file_memo.v1', id: 'file_1', reference: payload.reference,
        file: { path: 'C:\\work\\pelican-bicycle.html', name: 'pelican-bicycle.html', size: 10, mtimeMs: 1 }, note: { purpose: 'Animation', points: [] } } };
    } });
    f.references.link(label, 'cardbush-memo:1');
    await f.references.handle('artifact', '1', signal());
    assert.deepEqual(f.opened, [{ target: 'C:\\work\\pelican-bicycle.html', kind: 'file' }]);
  }
});

test('remote file links never point at the client filesystem; transfers use the scoped file API', async () => {
  const f = fixture(); f.references.setScope({ ...scope, local: false, platform: 'linux', workspace: '/remote' });
  assert.deepEqual(f.references.link('remote.md', './remote.md'), { text: 'remote.md [file 1]' });
  const requests = [], content = Buffer.from('remote 中文 file');
  const client = { async call(operation, input) {
    requests.push({ operation, input });
    return { name: 'remote.md', size: content.length, offset: input.offset, content: content.subarray(input.offset, input.offset + 8).toString('base64'), done: input.offset + 8 >= content.length };
  } };
  const path = await downloadChatArtifact(client, 'session', '/remote/remote.md', signal());
  try {
    assert.equal(await readFile(path, 'utf8'), content.toString());
    assert.ok(requests.every(call => call.operation === 'files.read' && call.input.sessionId === 'session'));
    assert.deepEqual(requests.map(call => call.input.offset), [0, 8, 16]);
  } finally { const directory = resolve(dirname(path)); assert.ok(directory.startsWith(resolve(tmpdir()) + sep + 'cardbush-artifact-')); await rm(directory, { recursive: true, force: true }); }
});

test('malformed transfers and unsafe server filenames cannot write or open a destination', async () => {
  for (const reply of [{ name: '../escape.txt', size: 1, offset: 0, content: 'eA==', done: true },
    { name: 'ok.txt', size: 10, offset: 0, content: '', done: false },
    { name: 'ok.txt', size: 10, offset: 0, content: 'eA==', done: true }]) {
    await assert.rejects(downloadChatArtifact({ call: async () => reply }, 'session', '/remote/test', signal()), /Invalid|Incomplete/);
  }
});
