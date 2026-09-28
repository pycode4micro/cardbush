import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as productAgent from '../packages/bush-product-agent/dist/index.js';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';
import * as react from 'react';
import { createProductAgentTurnRequest } from '../packages/bush-product-agent/dist/index.js';
const module = { exports: {} };
const source = ts.transpileModule(readFileSync('src/features/settings/conversationStyle.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
new Function('require', 'module', 'exports', source)(id => { if (id === '@cardbush/bush-product-agent') return productAgent; throw Error(id); }, module, module.exports);
const api = module.exports;
const sourceModule = { exports: {} };
const sourcePreferences = ts.transpileModule(readFileSync('src/features/settings/conversationSource.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
new Function('require', 'module', 'exports', sourcePreferences)(id => { if (id === 'react') return react; throw Error(id); }, sourceModule, sourceModule.exports);
const sourceApi = sourceModule.exports;
const memory = () => { const values = new Map(); return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }; };
function setup() {
  globalThis.localStorage = memory(); globalThis.sessionStorage = memory();
  globalThis.window = new EventTarget(); window.localStorage = localStorage;
}
const styles = [{ id: 'patient', name: '耐心同事', instructions: '温和耐心、坦诚表达。' }, { id: 'coach', name: '教练', instructions: '用鼓励的口吻交流。' }];
const preferences = { defaultId: 'professional', styles };

test('migrates active and inactive custom drafts once, preserving whitespace and invalid storage fallback', () => {
  setup();
  for (const mode of ['custom', 'natural']) {
    const old = { mode, customTone: '  温和\n耐心。  ' };
    localStorage.setItem(api.conversationStyleStorageKey, JSON.stringify(old));
    const migrated = api.readConversationStyle();
    assert.equal(migrated.styles[0].instructions, old.customTone);
    assert.equal(migrated.defaultId, mode === 'custom' ? 'custom-legacy' : mode);
    api.saveConversationStyle(migrated);
    assert.deepEqual(api.readConversationStyle(), migrated);
    assert.equal(api.conversationStyleName('custom-legacy', migrated, 'en'), 'Custom');
  }
  localStorage.setItem(api.conversationStyleStorageKey, '{broken');
  assert.equal(api.readConversationStyle().defaultId, 'natural');
});

test('per-chat and per-host selection stays isolated; reset follows default; deleted selection falls back', () => {
  setup(); api.saveConversationStyle(preferences);
  api.selectConversationStyle('a', 'patient'); api.selectConversationStyle('a', 'coach', 'remote');
  assert.deepEqual(api.resolveConversationStyle('a'), { mode: 'custom', customTone: styles[0].instructions });
  assert.deepEqual(api.resolveConversationStyle('a', 'remote'), { mode: 'custom', customTone: styles[1].instructions });
  assert.equal(api.resolveConversationStyle('b').mode, 'professional');
  assert.equal(api.readConversationStyle().defaultId, 'professional');
  api.saveConversationStyle({ ...preferences, defaultId: 'concise' });
  assert.equal(api.resolveConversationStyle('b').mode, 'concise');
  assert.equal(api.resolveConversationStyle('a').customTone, styles[0].instructions);
  api.selectConversationStyle('a', null);
  assert.equal(api.resolveConversationStyle('a').mode, 'concise');
  api.saveConversationStyle({ ...preferences, styles: [styles[0]], defaultId: 'patient' });
  assert.equal(api.resolveConversationStyle('a', 'remote').customTone, styles[0].instructions);
});

test('first-send draft selection transfers exactly once to the prepared session', () => {
  setup(); api.saveConversationStyle(preferences);
  api.selectConversationStyle('', 'coach');
  api.adoptDraftConversationStyle('created'); api.adoptDraftConversationStyle('another');
  assert.equal(api.resolveConversationStyle('created').customTone, styles[1].instructions);
  assert.equal(api.resolveConversationStyle('another').mode, 'professional');
  assert.equal(api.readConversationStyleOverride(''), null);
});

test('only selected instructions enter the prompt; style names and other saved instructions stay local', () => {
  setup(); api.saveConversationStyle(preferences); api.selectConversationStyle('a', 'patient');
  const request = createProductAgentTurnRequest({ requestId: 'r', sessionId: 'a', turnId: 't', messageId: 'm', createdAt: '2026-09-28T00:00:00Z',
    userText: '解释这个结果。', model: 'fixture', tools: [], conversationStyle: api.resolveConversationStyle('a') });
  const content = JSON.stringify(request);
  assert.ok(content.includes(styles[0].instructions));
  assert.ok(!content.includes(styles[0].name)); assert.ok(!content.includes(styles[1].instructions));
  const frozen = api.resolveConversationStyle('a');
  api.selectConversationStyle('a', 'coach');
  assert.equal(frozen.customTone, styles[0].instructions, 'changing style cannot mutate an already admitted turn');
});

test('malformed styles cannot shadow presets; missing default safely returns to natural', () => {
  const value = api.normalizeConversationStylePreferences({ defaultId: 'gone', styles: [null, {}, { id: 'natural', name: 'Fake', instructions: 'Fake' }, ...styles, styles[0]] });
  assert.equal(value.defaultId, 'natural'); assert.equal(value.styles.length, 2);
});


test('real new-conversation preparation adopts only the unassigned local draft', () => {
  const source = ts.createSourceFile('hook.ts', readFileSync('src/hooks/useCardbushChat.ts', 'utf8'), ts.ScriptTarget.Latest, true);
  const hook = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'useCardbushChat');
  const callback = hook.body.statements.flatMap(node => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : [])
    .find(node => node.name.getText(source) === 'prepareConversation').initializer.arguments[0].getText(source);
  const code = ts.transpileModule('exports.prepare = ' + callback, { compilerOptions: {target:ts.ScriptTarget.ES2022} }).outputText;
  for (const [scope, active, expected] of [[undefined, '', true], [undefined, 'existing', false], ['remote', '', false]]) {
    setup(); api.saveConversationStyle(preferences); api.selectConversationStyle('', 'coach');
    sourceApi.setConversationSource(false);
    const context = { exports:{}, backend:{scope}, activeConversationIdRef:{current:active}, preparedConversationsRef:{current:{}},
      navigationRevisionRef:{current:0}, conversationMatchesScope:()=>false, localConversation:()=>({id:'prepared'}),
      setPreparedConversationsById(){}, setMessagesByConversation(){}, setMessageHistoryLoading(){}, setActiveConversationId(){}, setError(){},
      adoptDraftConversationStyle:api.adoptDraftConversationStyle, adoptDraftConversationSource:sourceApi.adoptDraftConversationSource };
    vm.runInNewContext(code, context); context.exports.prepare();
    assert.equal(api.resolveConversationStyle('prepared').mode, expected ? 'custom' : 'professional');
    assert.equal(api.readConversationStyleOverride(''), expected ? null : 'coach');
    assert.equal(sourceApi.resolveConversationSource('prepared'), !expected);
    assert.equal(sourceApi.resolveConversationSource(''), expected);
  }
});
