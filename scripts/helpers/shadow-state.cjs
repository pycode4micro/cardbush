const assert = require('node:assert/strict');

module.exports = async ({ run, until }) => {
  await run(`
    window.crypto.randomUUID ??= () => require('node:crypto').randomUUID();
    window.shadowFixture = {
      createShadowConversation: async input => ({ id: input.clientConversationId, mode: input.mode, sourceTurnId: 'source-turn', workspaceDir: 'D:/fixture' }),
      closeShadowConversation: async () => {},
      fetchSessionMessages: async () => ({ messages: [] }),
      recordAssistantLogicFeedback: async () => {},
      updateShadowConversationMode: (id, mode) => new Promise(resolve => { window.finishShadowMode = () => resolve({ id, mode, workspaceDir: 'D:/fixture' }); }),
      streamShadowConversationMessage: request => new Promise(resolve => {
        window.finishShadowReply = () => { request.onDone({ content: 'Shadow fixture completed', createdAt: new Date().toISOString() }); resolve(); };
        request.signal.addEventListener('abort', () => resolve(), { once: true });
      }),
    };
    window.shadowContext = { sessionId: 'source', sourceTurnId: 'source-turn', title: 'Shadow rendering check',
      initialMode: 'readonly', theme: 'dark', language: 'zh', modelConfig: { id: 'fixture', modelName: 'Fixture model' },
      projectDir: 'D:/fixture', accentColor: '#7f9f8a' };
    renderView(h(views.ShadowWindow, { context: shadowContext, embedded: true }));
    window.typeShadowDraft = text => {
      const field = document.querySelector('.shadow-window-composer textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, text);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    };
    void 0;
  `);
  await until('document.querySelector(".shadow-window-composer textarea")?.disabled === false', 'Shadow history initialized');
  const send = '.shadow-window-send';
  const animation = () => run(`getComputedStyle(document.querySelector('${send} svg')).animationName`);
  assert.equal(await run(`document.querySelector('${send}').disabled`), true, 'empty input disables Send');
  assert.equal(await animation(), 'none', 'disabled Send must not spin');
  await run(`typeShadowDraft('Read this history')`);
  await until(`document.querySelector('${send}').disabled === false`, 'draft enables Send');
  assert.equal(await animation(), 'none');
  await run(`document.querySelector('${send}').click()`);
  await until(`document.querySelector('${send}.stop') !== null`, 'active reply shows Stop');
  assert.equal(await animation(), 'none', 'Stop is not a spinner');
  await run('finishShadowReply()');
  await until(`document.querySelector('${send}:not(.stop)')?.disabled === true`, 'completed reply returns to idle Send');
  assert.equal(await animation(), 'none');
  await run(`document.querySelectorAll('.shadow-window-mode-switch button')[1].click()`);
  await until('typeof finishShadowMode === "function"', 'mode switch in flight');
  assert.equal(await animation(), 'none', 'switching mode does not animate the disabled arrow');
  await run('finishShadowMode()');
  await until('document.querySelector(".shadow-mode-fork") !== null && !document.querySelector(".shadow-window-mode-switch button").disabled', 'Fork ready');
  assert.equal(await animation(), 'none');
  // Real loading indicators in the shared composer still animate explicitly.
  await run(`
    const loading = document.createElement('button'); loading.className = 'send-button fixture-loading'; loading.disabled = true;
    loading.innerHTML = '<svg class="spin"></svg>'; document.body.append(loading);
  `);
  assert.equal(await run('getComputedStyle(document.querySelector(".fixture-loading .spin")).animationName'), 'cardbush-spin');
  console.log('Shadow idle, sending, completed and mode-switch rendering passed');
};
