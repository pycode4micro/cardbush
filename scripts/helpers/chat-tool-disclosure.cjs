const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async ({ run, until, pause, window, root }) => {
  await run('window.disclosureSaved = { ...chatProps }; window.disclosureTheme = window.viewTheme; void 0;');
  try {
    for (const theme of ['theme-bright', 'theme-dark']) {
      await run(`
        window.viewTheme = ${JSON.stringify(theme)};
        window.disclosureHistory = Array.from({ length: 8 }, (_, index) => ({
          id: 'disclosure-history-' + index, role: index % 2 ? 'assistant' : 'user',
          content: ('Earlier context ' + index + '\\n\\n').repeat(4), turnId: 'disclosure-old-' + index,
        }));
        updateChat({ activeConversationId: 'disclosure-' + viewTheme, messages: disclosureHistory,
          sending: false, activeTurnId: '', loading: false, historyLoading: false,
          draft: '', goalWaiting: false, pendingInteraction: null, changeReports: [], error: null });
      `);
      await until('!!document.querySelector("[data-message-id=disclosure-history-7]")', 'disclosure history');
      await pause(400);
      await run(`
        updateChat({ sending: true, activeTurnId: 'disclosure-turn', messages: [...disclosureHistory,
          { id: 'disclosure-user', role: 'user', content: 'How long will it take?', turnId: 'disclosure-turn' },
          { id: 'disclosure-reply', role: 'assistant', content: 'I will check the official numbers.', turnId: 'disclosure-turn',
            toolExecutions: Array.from({ length: 6 }, (_, index) => ({
              id: 'disclosure-tool-' + index, name: 'terminal_exec', state: 'completed', success: true,
              output: 'Results', summary: 'Check', durationMs: 10, metadata: {},
              turnId: 'disclosure-turn', createdAt: '2026-09-17T00:00:00Z',
              contentOffset: 33, contentOffsetExplicit: true,
            })) },
        ] });
      `);
      await until('!!document.querySelector(".tool-execution-summary")', 'six tool operations');
      await pause(550);
      await run(`
        window.disclosureList = document.querySelector('.message-list');
        window.disclosureHeader = document.querySelector('.tool-execution-summary');
        window.disclosureFrames = [];
        window.disclosureAnchor = disclosureHeader;
        window.readDisclosure = label => ({ label, top: disclosureList.scrollTop, height: disclosureList.scrollHeight,
          y: disclosureAnchor.getBoundingClientRect().y,
          spacer: document.querySelector('.assistant-response-spacer').getBoundingClientRect().height,
          guard: disclosureList.dataset.cardbushPreserveScroll, motion: disclosureList.dataset.scrollAnimating });
        window.sampleDisclosure = () => {
          disclosureFrames.push(readDisclosure('frame'));
          window.disclosureFrame = requestAnimationFrame(sampleDisclosure);
        };
        disclosureHeader.click();
      `);
      await pause(250);
      const captureCollapse = async (name, click, preserveAnchor = true) => {
        await run(`
          disclosureFrames = [readDisclosure('before')];
          sampleDisclosure();
          ${click};
          disclosureFrames.push(readDisclosure('commit'));
        `);
        await pause(450);
        await run('cancelAnimationFrame(disclosureFrame)');
        const frames = await run('disclosureFrames');
        await fs.writeFile(path.join(root, 'tmp', 'tool-disclosure-' + theme + '-' + name + '.json'), JSON.stringify(frames, null, 2));
        const commitIndex = frames.findIndex(frame => frame.label === 'commit');
        const commit = frames[commitIndex];
        const subsequent = frames.slice(commitIndex);
        assert.ok(subsequent.length >= 5, 'sample several paints after collapse');
        assert.ok(subsequent.every(frame => Math.abs(frame.y - commit.y) <= 1 && Math.abs(frame.top - commit.top) <= 1),
          name + ': no later frame may undo the synchronous anchor correction');
        assert.ok(subsequent.every(frame => frame.height === commit.height && frame.spacer === commit.spacer),
          name + ': response space must be correct before the collapse commit returns');
        if (preserveAnchor) assert.ok(Math.abs(commit.y - frames[0].y) <= 1 && Math.abs(commit.top - frames[0].top) <= 1,
          name + ': collapse preserves the clicked anchor from the first frame');
        assert.equal(subsequent.at(-1).guard, undefined, 'scroll protection is released');
        assert.equal(await run('disclosureList.style.overflowAnchor'), '', 'native anchoring is restored');
        console.log('Disclosure collapse passed (' + theme + ', ' + name + '): ' + subsequent.length + ' stable frames.');
      };
      await captureCollapse('reserved-tail', 'disclosureHeader.click()');
      await fs.writeFile(path.join(root, 'tmp', 'tool-disclosure-' + theme + '.png'), (await window.capturePage()).toPNG());
      assert.equal(await run('disclosureHeader.getAttribute("aria-expanded")'), 'false');
      await captureCollapse('quick-toggle', 'disclosureHeader.click(); disclosureHeader.click()');

      // A nested row uses the same scroll transaction. It may require a single
      // bottom clamp, but must not paint a temporary position and bounce back.
      await run('disclosureHeader.click()');
      await until('document.querySelectorAll(".tool-execution-row").length === 6', 'operation list reopens');
      await run('window.disclosureRow = document.querySelector(".tool-execution-row"); disclosureRow.click();');
      await pause(350);
      await run('disclosureAnchor = disclosureRow; void 0;');
      await captureCollapse('nested-row', 'disclosureRow.click()', false);
      assert.equal(await run('disclosureRow.getAttribute("aria-expanded")'), 'false');

      await run(`
        updateChat({ messages: chatProps.messages.map(message => message.id !== 'disclosure-reply' ? message : {
          ...message, toolExecutions: [...message.toolExecutions, {
            id: 'disclosure-image', name: 'view_image', state: 'completed', success: true,
            output: '', summary: 'View image', durationMs: 10, metadata: {},
            turnId: 'disclosure-turn', createdAt: '2026-09-17T00:00:01Z',
            contentOffset: 33, contentOffsetExplicit: true,
            artifacts: [{ id: 'disclosure-image-file', type: 'image', name: 'preview.png',
              path: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' }],
          }],
        }) });
      `);
      await until("!!document.querySelector('.loop-image-previews .loop-preview-summary')", 'image group');
      await pause(450);
      await run("window.disclosureImages = document.querySelector('.loop-image-previews .loop-preview-summary'); disclosureAnchor = disclosureImages; void 0;");
      await captureCollapse('image-group', 'disclosureImages.click()', false);
      assert.equal(await run('disclosureImages.getAttribute("aria-expanded")'), 'false');
      await captureCollapse('image-quick-toggle', 'disclosureImages.click(); disclosureImages.click()');

      // Manual reading clears the response reservation. Toggling must neither
      // recreate it nor allow resize following to take over the reader's scroll.
      await run(`
        disclosureList.dispatchEvent(new WheelEvent('wheel', { deltaY: -250, bubbles: true, cancelable: true }));
        disclosureList.scrollTop -= 250;
        disclosureAnchor = disclosureHeader;
        void 0;
      `);
      await pause(250);
      assert.equal(await run('document.querySelector(".assistant-response-spacer").dataset.anchorKey'), '');
      await captureCollapse('detached', 'disclosureHeader.click()');
      assert.equal(await run('document.querySelector(".assistant-response-spacer").getBoundingClientRect().height'), 0);
    }
  } finally {
    await run('cancelAnimationFrame(window.disclosureFrame); window.viewTheme = disclosureTheme; updateChat(disclosureSaved);');
    await pause();
  }
};
