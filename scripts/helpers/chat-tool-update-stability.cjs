const assert = require('node:assert/strict');

// Match the real loop: existing narration + a large image, followed by many
// textless tool rounds. Sample every paint, not just the settled DOM.
module.exports = async ({ run, until, pause, window, root, theme = 'theme-bright' }) => {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const styleKey = await window.webContents.insertCSS(await fs.readFile(path.join(root, 'src/features/tools/message-tool-outputs.css'), 'utf8'));
  await run('window.stabilityOriginal = { props: { ...chatProps }, theme: window.viewTheme }; void 0;');
  try {
  await run(`
    {
    window.viewTheme = ${JSON.stringify(theme)};
    const canvas = document.createElement('canvas');
    canvas.width = 1280; canvas.height = 720;
    const context = canvas.getContext('2d');
    context.fillStyle = '#a3afa0'; context.fillRect(0, 0, 1280, 720);
    window.stabilityImage = canvas.toDataURL();
    window.stabilitySession = 'tool-stability-' + viewTheme;
    window.stabilityState = { [stabilitySession]: [
      ...Array.from({ length: 6 }, (_, index) => ({ id: 'stable-history-' + index,
        role: index % 2 ? 'assistant' : 'user', content: ('Earlier context ' + index + '\\n\\n').repeat(6),
        turnId: 'stable-history-turn-' + index })),
      { id: 'stable-user', role: 'user', content: 'Continue the render', turnId: 'stable-turn' },
      { id: 'stable-intro', assistantMessageId: 'stable-intro', role: 'assistant', content: 'This narration and preview stay in place.', turnId: 'stable-turn',
        toolExecutions: [{ id: 'stable-image-tool', name: 'present_artifact', state: 'completed',
          success: true, output: '', summary: 'Preview', metadata: {}, durationMs: 10,
          createdAt: '2026-09-13T00:00:00Z', turnId: 'stable-turn',
          contentOffset: 40, contentOffsetExplicit: true,
          artifacts: [{ id: 'stable-image', name: 'preview.png', type: 'image', path: stabilityImage }] }] },
    ] };
    window.renderStability = () => updateChat({ activeConversationId: stabilitySession,
      messages: stabilityState[stabilitySession], loading: false, historyLoading: false,
      sending: true, activeTurnId: 'stable-turn', draft: '' });
    window.updateStabilityTool = (id, state, sequence) => {
      stabilityState = views.appendToolExecution(stabilityState, stabilitySession, 'stable-intro', {
        id, name: 'terminal_exec', state, success: state === 'completed', output: '', summary: 'Check render',
        durationMs: 10, metadata: {}, assistantMessageId: 'owner-' + id,
        turnId: 'stable-turn', sequence, contentOffset: 0, contentOffsetExplicit: true,
        createdAt: '2026-09-13T00:00:01Z',
      });
      renderStability();
    };
    renderStability();
    }
  `);
  await until("document.querySelector('.message-tool-artifact img')?.naturalWidth === 1280", 'large tool preview loaded');
  await pause(600);
  await run(`
    window.stableList = document.querySelector('.message-list');
    window.stableRow = document.querySelector('.message-row.streaming');
    window.stableImage = stableRow.querySelector('.message-tool-artifact img');
    window.stableParagraph = stableRow.querySelector('.markdown-content p');
    window.stableToolBlock = stableRow.querySelector('.tool-execution-block');
    window.stabilityBaseline = { top: stableList.scrollTop, height: stableList.scrollHeight, y: stableImage.getBoundingClientRect().y };
    window.stabilityFrames = [];
    window.stabilityLoads = 0;
    stableImage.addEventListener('load', () => stabilityLoads++);
    window.sampleStability = () => {
      stabilityFrames.push({ top: stableList.scrollTop, height: stableList.scrollHeight,
        y: stableImage.getBoundingClientRect().y,
        activity: stableRow.querySelector('.assistant-thinking-process')?.textContent,
        blocks: [...stableRow.querySelectorAll('.assistant-active-transcript > *, .assistant-message-content > *, .assistant-run-header')]
          .map(node => [node.className, node.getBoundingClientRect().height, node.classList.contains('tool-execution-block') ? node.textContent : '']),
        mounted: stableImage.isConnected && stableParagraph.isConnected && stableToolBlock.isConnected });
      window.stabilityFrame = requestAnimationFrame(sampleStability);
    };
    sampleStability();
  `);
  for (let i = 1; i <= 4; i++) {
    for (const state of ['queued', 'running', 'completed']) {
      await run(`updateStabilityTool('stable-tool-${i}', '${state}', ${i});`);
      await pause(220);
    }
  }
  await run('cancelAnimationFrame(stabilityFrame)');
  const result = await run('({ baseline: stabilityBaseline, frames: stabilityFrames, loads: stabilityLoads })');
  const heightRange = Math.max(...result.frames.map(frame => frame.height)) - Math.min(...result.frames.map(frame => frame.height));
  const imageRange = Math.max(...result.frames.map(frame => frame.y)) - Math.min(...result.frames.map(frame => frame.y));
  console.log('Tool update geometry (' + theme + '):', JSON.stringify({ heightRange, imageRange, loads: result.loads }));
  assert.ok(result.frames.every(frame => frame.mounted), 'tool updates retain the narration, package and image nodes');
  assert.ok(heightRange <= 1, 'tool-only lifecycle updates must not remove/reinsert a line of transcript height');
  assert.ok(imageRange <= 1, 'an existing large preview must not bounce when the tool count/status changes');
  assert.equal(result.loads, 0, 'unchanged media never reloads');
  await fs.writeFile(path.join(root, 'tmp/chat-tool-update-' + theme + '.png'), (await window.capturePage()).toPNG());

  await run(`
    stableList.dispatchEvent(new WheelEvent('wheel', { deltaY: -250, bubbles: true, cancelable: true }));
    stableList.scrollTop = Math.max(0, stableList.scrollTop - 350);
  `);
  await pause(250);
  const detachedTop = await run('stableList.scrollTop');
  await run("updateStabilityTool('stable-tool-5', 'running', 5)");
  await pause(250);
  await run("updateStabilityTool('stable-tool-5', 'completed', 5)");
  await pause(250);
  assert.ok(Math.abs(await run('stableList.scrollTop') - detachedTop) <= 1, 'tool updates preserve a detached reader');
  await run("stableToolBlock.querySelector('.tool-execution-summary').click()");
  await until("stableToolBlock.querySelectorAll('[data-execution-id]').length === 6", 'tool details still expand');
  await run("updateStabilityTool('stable-tool-5', 'failed', 5)");
  await until("stableToolBlock.textContent.includes('1 failed')", 'late tool results still update');
  assert.equal(await run('stableImage.isConnected && stableParagraph.isConnected'), true);
  await run("stableToolBlock.querySelector('.tool-execution-summary').click()");
  console.log('Tool update stability passed (' + theme + '): lifecycle, large media, per-frame geometry, detached reading and disclosure.');
  } finally {
    await run('cancelAnimationFrame(window.stabilityFrame); window.viewTheme = stabilityOriginal.theme; updateChat(stabilityOriginal.props);');
    await window.webContents.removeInsertedCSS(styleKey);
    await pause();
  }
};
