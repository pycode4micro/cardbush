const assert = require('node:assert/strict');

module.exports = async ({ run, until, window, root }) => {
  await run('window.protocolSavedProps = { ...chatProps }; renderView(null);');
  await until('!document.querySelector(".chat-panel")', 'previous fixture unmounted');
  try {
    for (const surface of ['welcome', 'conversation', 'embedded']) {
      await run(`updateChat({ loading: false, historyLoading: false, language: 'en',
        activeConversationId: ${JSON.stringify(surface)}, embedded: ${surface === 'embedded'},
        welcomeEnabled: ${surface === 'welcome'}, messages: [],
        availableModels: [
          { id: 'chat', modelName: 'Chat fixture', provider: 'fixture', apiProtocol: 'openai_chat_completions', enabled: true },
          { id: 'responses', modelName: 'Responses fixture', provider: 'fixture', apiProtocol: 'openai_responses', enabled: true },
          { id: 'messages', modelName: 'Messages fixture', provider: 'fixture', apiProtocol: 'anthropic_messages', anthropicThinkingMode: 'adaptive', enabled: true },
          { id: 'budget', modelName: 'Budget fixture', provider: 'fixture', apiProtocol: 'anthropic_messages', anthropicThinkingMode: 'budget', enabled: true },
          { id: 'legacy', modelName: 'Legacy fixture', provider: 'fixture', enabled: true }
        ], selectedModel: 'chat', reasoningLevelAvailable: true, reasoningLevel: 'max',
        reasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
        onModelChange: selectedModel => updateChat({ selectedModel }),
        onReasoningLevelChange: reasoningLevel => updateChat({ reasoningLevel }) });`);
      await until('!!document.querySelector(".model-select")', `${surface} model control`);
      assert.equal(await run('document.querySelector(".model-select span").textContent'), 'Chat fixture', `${surface} closed selector shows only model name`);
      assert.equal(await run('document.querySelector(".model-select").title'), 'Model: Chat fixture');
      await run('document.querySelector(".model-select").click()');
      await until('!!document.querySelector(".model-reasoning-primary-options button")', `${surface} reasoning menu`);
      assert.deepEqual(await run('[...document.querySelectorAll(".model-reasoning-options button")].map(button => button.textContent)'), ['Low', 'Medium', 'High']);
      assert.equal(await run('document.querySelector(".model-reasoning-primary-options button.active")?.textContent'), 'High');
      await run('document.querySelector(".model-reasoning-default").click()');
      await until('chatProps.reasoningLevel === "default"', 'provider default is selectable');
      assert.equal(await run('document.querySelectorAll(".model-reasoning-options button.active").length'), 0, 'default is distinct from none and low');
      assert.equal(await run('document.querySelector(".model-reasoning-default").getAttribute("aria-pressed")'), 'true');
      await run('updateChat({ reasoningLevel: "max" })');
      assert.equal(await run('chatProps.reasoningLevel'), 'max', 'Rendering a protocol must not overwrite the saved Responses preference');
      assert.deepEqual(await run('[...document.querySelectorAll(".model-picker-protocol")].map(node => node.textContent)'),
        ['Chat Completions', 'Responses', 'Messages', 'Messages', 'Responses']);
      assert.equal(await run('document.querySelector(".model-picker-meta").title'), 'fixture · OpenAI Chat Completions');
      assert.equal(await run('document.querySelector(".model-reasoning-section .model-picker-inline-label span").textContent'), 'Reasoning effort');
      assert.equal(await run('document.querySelector(".model-reasoning-options").classList.contains("single-page")'), true);
      await run('[...document.querySelectorAll(".model-picker-row")].find(button => button.textContent.includes("Responses fixture")).click()');
      await until('chatProps.selectedModel === "responses"', 'switch to Responses');
      // Selecting a model closes the popover.
      await until('!document.querySelector(".model-reasoning-section")', 'model menu closed');
      assert.equal(await run('document.querySelector(".model-select span").textContent'), 'Responses fixture', 'selected name updates without provider or protocol');
      await run('document.querySelector(".model-select").click()');
      await until('document.querySelector(".model-reasoning-primary-options button.active")?.textContent === "Max"', 'Responses retains max');
      assert.equal(await run('document.querySelectorAll(".model-reasoning-primary-options button, .model-reasoning-secondary-options button").length'), 6);
      for (const [id, heading] of [['messages', 'Thinking effort'], ['budget', 'Thinking budget']]) {
        await run(`[...document.querySelectorAll('.model-picker-row')].find(button => button.textContent.includes(${JSON.stringify(id === 'messages' ? 'Messages fixture' : 'Budget fixture')})).click()`);
        await until(`chatProps.selectedModel === '${id}' && !document.querySelector('.model-reasoning-section')`, 'selected protocol closes menu');
        await run('document.querySelector(".model-select").click()');
        await until(`document.querySelector('.model-reasoning-section .model-picker-inline-label span')?.textContent === '${heading}'`, `${surface} ${heading}`);
        assert.equal(await run('document.querySelector(".model-reasoning-primary-options button.active")?.textContent'), 'Max');
        assert.equal(await run('document.querySelectorAll(".model-reasoning-primary-options button, .model-reasoning-secondary-options button").length'), 6);
      }
      await run('document.querySelector(".model-select").click();');
      await until('!document.querySelector(".model-reasoning-section")', 'reasoning menu dismissed');
      await run('updateChat({ selectedModel: "chat", language: "zh", reasoningLevel: "none" });');
      await run('document.querySelector(".model-select").click()');
      await until('document.querySelector(".model-reasoning-primary-options button.active")?.textContent === "低"', 'legacy none uses lowest supported effort');
      await run('document.querySelectorAll(".model-reasoning-primary-options button")[1].click()');
      await until('chatProps.reasoningLevel === "medium"', 'selection updates the shared conversation state');
      await run('updateChat({ selectedModel: "messages", reasoningLevel: "low" });');
      await until('document.querySelector(".model-reasoning-section .model-picker-inline-label span")?.textContent === "思考强度" && !!document.querySelector(".model-reasoning-options.expanded")', 'Messages low selection is visible after protocol switch');
      assert.equal(await run('document.querySelector(".model-reasoning-secondary-options button.active")?.textContent'), '低');
      await run('updateChat({ selectedModel: "budget" });');
      await until('document.querySelector(".model-reasoning-section .model-picker-inline-label span")?.textContent === "思考预算"', 'localized budget mode');
      await run('updateChat({ selectedModel: "chat" });');
      await until('!!document.querySelector(".model-reasoning-options.single-page:not(.expanded)")', 'three-level mode resets expanded page');
      assert.equal(await run('document.querySelector(".model-reasoning-primary-options button.active")?.textContent'), '低');
      const layout = await run(`[...document.querySelectorAll('.model-picker-meta')].map(meta => {
        const provider = meta.querySelector('.model-picker-provider').getBoundingClientRect();
        const protocol = meta.querySelector('.model-picker-protocol').getBoundingClientRect();
        const row = meta.closest('.model-picker-row').getBoundingClientRect();
        return { sameLine: Math.abs(provider.top - protocol.top) < 1, fits: protocol.right <= row.right };
      })`);
      assert.ok(layout.every(row => row.sameLine && row.fits), `${surface} provider and protocol fit on one line`);
      if (surface === 'embedded' && window && root) {
        const fs = require('node:fs'), path = require('node:path');
        await run('updateChat({ selectedModel: "messages", reasoningLevel: "max" });');
        await until('!document.querySelector(".model-reasoning-options.expanded")', 'preview selected page');
        await new Promise(resolve => setTimeout(resolve, 300));
        const rect = await run(`(() => { const r = document.querySelector('.model-picker-menu').getBoundingClientRect(); return { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height) }; })()`);
        fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
        fs.writeFileSync(path.join(root, 'tmp/composer-model-protocols.png'), (await window.capturePage(rect)).toPNG());
      }
      await run('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); renderView(null);');
      await until('!document.querySelector(".chat-panel")', 'fixture unmounted');
    }
    console.log('Protocol reasoning picker passed: welcome, conversation, embedded; all protocol labels, adaptive/budget modes, English/Chinese, selected page and saved preference.');
  } finally { await run('window.chatProps = protocolSavedProps; updateChat({});'); }
};
