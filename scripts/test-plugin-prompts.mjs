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
assert.equal(snapshot.application, 'CardBush');
assert.equal(snapshot.pluginRoot, 'C:/Plugin Packages/example');
assert.equal(snapshot.configuredLaunch, null, 'unavailable launch information is not invented');
assert.match(prompt, /manifestPath、pluginRoot 和 serviceId/);
for (const language of ['zh', 'en']) {
  const value = pluginTroubleshootingPrompt(plugin, { id: 's', name: 'Example', state: 'unavailable' }, language);
  assert.doesNotMatch(value.slice(reference.length, value.indexOf('\n{')), /codex|claude|terminal_exec/i,
    'generic repair instructions do not embed product names or tool examples from an individual incident');
}
const context = {
  application: 'CardBush', capturedAt: '2026-09-15T08:00:00Z', pluginId: plugin.id,
  version: '1.2.4+codex.20260915', source: 'user', manifestPath: 'C:/CardBush/plugins/example/plugin.json',
  pluginRoot: 'C:/CardBush/plugins/example', pluginEnabled: true, componentId: 'server', serviceId: 'plugin_example_tools_server',
  pluginConfigurationRevision: 43, mcpConfigurationRevision: 8,
  configuredLaunch: { transport: 'stdio', command: 'powershell.exe', args: ['-File', 'C:/CardBush/plugins/example/launch.ps1'], cwd: 'C:/CardBush/plugins/example', environmentNames: ['API_KEY'] },
};
const withContext = pluginTroubleshootingPrompt(plugin, { id: context.serviceId, name: 'Example', state: 'unavailable',
  configurationRevision: 7, restartAttempts: 3, toolCount: 0, error: 'password="two secret words" https://user:pass@example.test/mcp?ticket=PRIVATE_TICKET#PRIVATE_FRAGMENT',
}, 'zh', context);
const evidence = JSON.parse(withContext.slice(withContext.indexOf('\n{') + 1));
assert.ok(withContext.startsWith('[$example.tools](<C:/CardBush/plugins/example/plugin.json>)'), 'fresh host identity replaces the stale catalog path in the draft');
assert.equal(evidence.version, context.version, 'version labels never change installation ownership');
assert.equal(evidence.pluginRoot, context.pluginRoot);
assert.deepEqual(evidence.configuredLaunch, context.configuredLaunch);
assert.equal(evidence.pluginConfigurationRevision, 43);
assert.equal(evidence.displayedRuntimeConfigurationRevision, 7, 'displayed health is not relabeled as the fresh configuration');
assert.doesNotMatch(withContext, /two secret words|PRIVATE_TICKET|PRIVATE_FRAGMENT|user:pass/);
const wrongTarget = pluginTroubleshootingPrompt(plugin, { id: 'different_service', name: 'Other', state: 'unavailable' }, 'zh', context);
assert.doesNotMatch(wrongTarget, /C:\/CardBush\/plugins\/example/, 'context for another service cannot retarget the repair');
for (const [manifestPath, pluginRoot] of [['/opt/cardbush/plugins/example/plugin.json', '/opt/cardbush/plugins/example'],
  ['//server/plugins/example/.claude-plugin/plugin.json', '//server/plugins/example']]) {
  const fallback = pluginTroubleshootingPrompt({ ...plugin, manifestPath }, { id: 's', name: 'Example', state: 'unavailable' }, 'zh');
  assert.equal(JSON.parse(fallback.slice(fallback.indexOf('\n{') + 1)).pluginRoot, pluginRoot);
}
assert.ok(pluginTroubleshootingPrompt(plugin, { id: 's', name: 'Example', state: 'configuration_required' }, 'en')
  .startsWith(`${reference} Report progress and final results in English. Investigate this plugin connection failure in CardBush.`));
// Exercise the actual send parser, not just the prefill generator.
const localPaths = {};
new Function('exports', ts.transpileModule(readFileSync('src/shared/localPaths.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText)(localPaths);
const hookSource = readFileSync('src/hooks/useCardbushChat.ts', 'utf8');
const hookAst = ts.createSourceFile('useCardbushChat.ts', hookSource, ts.ScriptTarget.Latest, true);
const sendParserSource = hookAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'splitStreamAttachmentMentions').getText(hookAst);
const splitOutbound = new Function('splitExplicitAttachmentMentions', 'isImagePath',
  ts.transpileModule(sendParserSource + '\nreturn splitStreamAttachmentMentions;', {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText)(localPaths.splitExplicitAttachmentMentions, localPaths.isImagePath);
for (const scriptPath of ['C:\\Plugin Packages\\工具\\launch-hidden.ps1', '/opt/plugin/launch.sh', '\\\\server\\share\\launch.cmd']) {
  const launch = { ...context.configuredLaunch, args: ['-File', scriptPath] };
  const draft = pluginTroubleshootingPrompt(plugin, { id: context.serviceId, name: 'Example', state: 'unavailable' }, 'zh', { ...context, configuredLaunch: launch });
  const outbound = splitOutbound(draft);
  assert.equal(outbound.userInput, draft);
  assert.equal(outbound.displayInput, draft);
  assert.deepEqual(outbound.files, []);
  assert.deepEqual(JSON.parse(outbound.userInput.slice(outbound.userInput.indexOf('\n{') + 1)).configuredLaunch, launch);
}
const literals = '路径说明\n"C:\\example\\launch.ps1"\n/opt/example/start.sh\n```text\n@C:\\example\\literal.txt\n```\n    @C:\\example\\indented.txt';
assert.equal(splitOutbound(literals).userInput, literals, 'paths and code samples are literal content');
assert.deepEqual(splitOutbound(literals).files, []);
const attached = splitOutbound(literals + '\n@"C:\\Files With Spaces\\report.xlsx"\n@C:\\images\\sample.png');
assert.equal(attached.userInput, literals);
assert.deepEqual(attached.files, ['C:\\Files With Spaces\\report.xlsx']);
assert.deepEqual(attached.images, [{ path: 'C:\\images\\sample.png' }]);
console.log('Plugin prompts passed: exact references, unambiguous identity, authored positions, localized evidence and credential omission.');
