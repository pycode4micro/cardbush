import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { Script, runInNewContext } from 'node:vm';
import { renderPromptTemplate } from '@cardbush/platform/prompts';
import { loadChatTranscript } from './helpers/load-chat-transcript.mjs';

const { mcpAppDocument } = await loadChatTranscript({
  source: `export { mcpAppDocument } from ${JSON.stringify(resolve('src/features/tools/mcpAppBridge.ts'))};`,
  globals: { document: { documentElement: { lang: 'en' } } },
});

test('model policies match reviewed text, slots and CommonJS packaging', async () => {
  const fixtures = JSON.parse(await readFile(new URL('./fixtures/prompt-template-digests.json', import.meta.url), 'utf8'));
  const native = createRequire(import.meta.url)('@cardbush/platform/prompts');
  for (const { name, slots, sha256 } of fixtures) {
    const values = Object.fromEntries(slots.map(key => [key, `<${key}>$&{{value:other}}`]));
    const output = renderPromptTemplate(name, values);
    assert.equal(createHash('sha256').update(output).digest('hex'), sha256, name);
    assert.equal(native.renderPromptTemplate(name, values), output, name);
  }
  assert.throws(() => renderPromptTemplate('__proto__'), /Unknown/);
  assert.throws(() => renderPromptTemplate('assistant-system'), /Missing/);
  assert.throws(() => renderPromptTemplate('goal-continuation-prompt', { extra: 'x' }), /Unexpected/);
});

test('Friends starts from recognition and learns gradually without making habits or model polling prerequisites', () => {
  const policy = renderPromptTemplate('friends-system');
  assert.match(policy, /not a prerequisite for starting/);
  assert.match(policy, /without waiting for the user to type a task/);
  assert.match(policy, /habitRefs may be empty/);
  assert.match(policy, /at most one new event/);
  assert.match(policy, /Silence, your own suggestions, a timer firing and successful execution are not evidence/);
  assert.match(policy, /summary_for_user or revise_memory tools only when enabled/);
  assert.match(policy, /not tool permission grants/);
  assert.match(policy, /Waiting does not require model polling/);
  assert.doesNotMatch(policy, /Do not create or revise habits as part of this integration/);
  assert.match(renderPromptTemplate('friends-startup'), /even when no saved habits exist/);
});


test('MCP document keeps host CSP first and treats provider inputs as inert JSON', () => {
  const hostile = '</script><script>compromised=true</script>\n$&{{json:theme}}';
  const provider = '<section id="provider">Provider content</section>';
  const html = mcpAppDocument({ token: 'not-in-frame', html: provider, input: { text: hostile }, result: { structuredContent: { text: hostile } }, tool: {}, meta: { ui: { csp: { connectDomains: ['https://allowed.example', 'https://bad.example; script-src *'] } } } }, 'zh', 'dark', { '--accent': hostile });
  assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<script>'));
  assert.ok(html.includes('https://allowed.example')); assert.ok(!html.includes('bad.example'));
  assert.ok(html.endsWith(provider + '\n')); assert.ok(!html.includes('not-in-frame'));
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1); new Script(scripts[0][1]);
  assert.ok(scripts[0][1].includes('宿主请求超时'));
  const initial = scripts[0][1].match(/const api = (.*);/)[1];
  assert.equal(runInNewContext(initial).toolInput.text, hostile);
});

test('UI bridge sources cannot reintroduce embedded document shells', async () => {
  for (const file of ['src/features/tools/mcpAppBridge.ts']) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /<(?:!doctype|style|script)[\s>]/i, file);
  }
});

test('all shipped model templates are English while interpolated user content stays verbatim', async () => {
  const { readdir } = await import('node:fs/promises');
  for (const file of await readdir('assets/prompts')) {
    if (!file.endsWith('.md')) continue;
    const source = await readFile(`assets/prompts/${file}`, 'utf8');
    assert.doesNotMatch(source, /\p{Script=Han}/u, file);
  }
  const persona = '保持中文原文 $& {{value:name}}';
  const output = renderPromptTemplate('assistant-system', { name: '小树', persona, host: 'local', eventPolicy: renderPromptTemplate('assistant-events-enabled') });
  assert.ok(output.includes(persona));
  assert.ok(output.includes('小树'));
});
