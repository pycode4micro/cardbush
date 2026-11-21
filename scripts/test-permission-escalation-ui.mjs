import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as i18n from '@cardbush/platform/i18n';

const require = createRequire(import.meta.url), exports = {};
vm.runInNewContext(ts.transpileModule(readFileSync('src/features/interactions/PermissionRequestCard.tsx', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText, { exports, require: name => name === '../../i18n' ? i18n : require(name) });

test('human escalation explains the remote restriction in the selected language and preserves exact approval controls', () => {
  const interaction = { id: 'approval', type: 'path_permission_request', sessionId: 'child', turnId: 'turn',
    runtimePermission: { reason: 'Read <private> input', actions: ['read'], targets: [{ kind: 'filesystem_path', value: '/srv/input' }], requestedCapabilityIds: ['read'] },
    raw: { protocol: 'bush.runtime_permission_answer.v1', subagentTaskId: 'task', permissionRouting: 'user',
      permissionEscalationReason: 'remote_policy_requires_human' } };
  for (const language of ['en', 'zh', 'en']) {
    const render = value => renderToStaticMarkup(createElement(exports.PermissionRequestCard, {
      language, interaction: value, busy: false, onChoose() {}, onCancel() {},
    }));
    const html = render(interaction);
    assert.ok(html.includes(i18n.uiText(language)('permissionRequestCard.remotePolicyRequiresHuman')));
    assert.ok(html.includes(i18n.uiText(language)('permission.subagentTitle')));
    assert.ok(html.includes('/srv/input'));
    assert.ok(html.includes('Read &lt;private&gt; input'));
    assert.equal((html.match(/class="permission-action /g) ?? []).length, 3);
    const ordinary = render({ ...interaction, raw: { ...interaction.raw, permissionEscalationReason: undefined } });
    assert.ok(!ordinary.includes(i18n.uiText(language)('permissionRequestCard.remotePolicyRequiresHuman')));
  }
});

test('a long terminal approval preserves the whole command in its collapsed disclosure and keeps decisions outside it', () => {
  const command = 'command ' + 'parameter '.repeat(180) + 'last-argument';
  const html = renderToStaticMarkup(createElement(exports.PermissionRequestCard, {
    language: 'en', busy: false, onChoose() {}, onCancel() {},
    interaction: { id: 'terminal', sessionId: 'ordinary', raw: {}, runtimePermission: {
      actions: ['execute'], targets: [{ kind: 'process', value: command }],
    } },
  }));
  assert.match(html, /<details class="permission-disclosure"><summary>/);
  assert.ok(html.includes(`<pre class="permission-full-target">${command}</pre>`));
  assert.match(html, /<code>command [^<]+…<\/code>/);
  assert.ok(html.indexOf('class="permission-actions"') > html.indexOf('</details>'));
});
