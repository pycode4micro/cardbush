import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync('src/features/plugins/pluginPrompts.ts', 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
const exports = {};
new Function('exports', outputText)(exports);
const { pluginReference, pluginPrompt, pluginPromptParts, pluginTroubleshootingPrompt, pluginReferenceFromLink, findReferencedPlugin } = exports;
const plugin = { id: 'example.tools', name: '同名插件', version: '1.2.3', manifestPath: 'C:\\Plugin Packages\\example\\.codex-plugin\\plugin.json', config: { env: { API_KEY: 'do-not-send-config' } } };
const other = { ...plugin, id: 'other', manifestPath: 'C:/other/plugin.json' };
const reference = pluginReference(plugin);
assert.equal(reference, '[$example.tools](<C:/Plugin Packages/example/.codex-plugin/plugin.json>)');
const draft = `说明 ${reference} 完成任务\n${pluginReference(other)} 第二项`;
const parts = pluginPromptParts(draft, [plugin, other]);
assert.equal(parts.map(part => part.text).join(''), draft, 'authored text and reference positions are lossless');
assert.deepEqual(parts.filter(part => part.plugin).map(part => part.plugin.id), ['example.tools', 'other'], 'identical display names do not conflate identities');
for (const part of parts) assert.equal(draft.slice(part.start, part.start + part.text.length), part.text);
for (const ordinary of ['$HOME $5', '[$example.tools](<C:/different/plugin.json>)', '[$missing](<C:/plugin.json>)']) {
  assert.equal(pluginPromptParts(ordinary, [plugin]).some(part => part.plugin), false, 'ordinary or unresolved text is never silently converted');
}
assert.equal(pluginPrompt(plugin, '  检查状态  '), `${reference} 检查状态`);
const coldReference = pluginPromptParts(`${reference} 检查状态`, [])[0];
assert.deepEqual(coldReference.reference, { id: plugin.id, manifestPath: 'C:/Plugin Packages/example/.codex-plugin/plugin.json' }, 'a persisted reference retains its plugin identity before catalog loading');
assert.equal(findReferencedPlugin(coldReference.reference, [plugin]), plugin);
assert.equal(findReferencedPlugin({ ...coldReference.reference, manifestPath: 'c:/plugin packages/EXAMPLE/.codex-plugin/plugin.json' }, [plugin]), plugin);
assert.equal(findReferencedPlugin({ ...coldReference.reference, manifestPath: 'C:/other/plugin.json' }, [plugin]), undefined, 'same id in a different path must not borrow another plugin icon');
for (const [label, path] of [['plugin.json', plugin.manifestPath], ['$HOME', 'C:/settings.json'], ['$example.tools', 'https://example.com/plugin.json']]) {
  assert.equal(pluginReferenceFromLink(label, path), null, 'ordinary files and remote links keep their existing rendering');
}
const prompt = pluginTroubleshootingPrompt(plugin, {
  id: 'plugin_example_tools_server', name: 'Example', state: 'unavailable', transport: 'stdio',
  error: 'Python was not found; Bearer hidden-token; "api_key":"hidden-key"; https://user:password@example.test/mcp',
}, 'zh');
assert.ok(prompt.startsWith(`${reference} 请用中文汇报进度和最终结果。`));
assert.match(prompt, /Python was not found/);
assert.match(prompt, /plugin_example_tools_server/);
assert.match(prompt, /先读取插件清单和安装说明/);
assert.doesNotMatch(prompt, /hidden-token|hidden-key|user:password|do-not-send-config/);
const snapshot = JSON.parse(prompt.slice(prompt.indexOf('\n{') + 1));
assert.equal(snapshot.state, 'unavailable');
assert.equal(snapshot.transport, 'stdio');
assert.equal(snapshot.version, '1.2.3');
assert.ok(pluginTroubleshootingPrompt(plugin, { id: 's', name: 'Example', state: 'configuration_required' }, 'en')
  .startsWith(`${reference} Report progress and final results in English. Investigate this plugin connection failure.`));
console.log('Plugin prompts passed: exact references, unambiguous identity, authored positions, localized evidence and credential omission.');
