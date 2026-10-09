const assert = require('node:assert/strict');

module.exports = async ({ run, until, pause }) => {
  await run(`
    window.reflowSaved = { ...chatProps };
    const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 1600;
    const context = canvas.getContext('2d'); context.fillStyle = '#698baf'; context.fillRect(0, 0, 800, 1600);
    window.reflowImage = canvas.toDataURL();
    window.reflowWidth = width => { document.querySelector('.chat-panel').style.width = width + 'px'; };
    window.reflowList = () => document.querySelector('.message-list');
    window.reflowDetach = top => {
      reflowList().dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }));
      reflowList().scrollTop = top;
    };
    window.reflowMessages = [
      { id: 'reflow-user', role: 'user', content: 'Find presentation templates', turnId: 'reflow-turn' },
      { id: 'reflow-answer', role: 'assistant', turnId: 'reflow-turn', status: 'completed',
        metadata: { transcript_kind: 'assistant_final' }, content:
          '![Large template screenshot](' + reflowImage + ')\\n\\n' +
          '- [Open template](https://example.test/templates)\\n\\n' +
          'Template details: '.repeat(150) + '\\n\\nThe final result stays here.' },
    ];
    updateChat({ activeConversationId: 'reflow-scroll', loading: false, sending: false,
      activeTurnId: '', messages: reflowMessages, draft: '' });
  `);
  await until('document.querySelector(".assistant-final-answer img")?.naturalWidth === 800', 'reflow image loaded');
  await pause(600);
  try {
    // The same host event dispatched by a reply link opens the split pane.
    await run(`window.reflowOpen = () => reflowWidth(370);
      addEventListener('cardbush:open-inspector', reflowOpen);
      document.querySelector('.assistant-final-answer a').click();`);
    await pause(450);
    await run('reflowWidth(900)');
    await pause(450);
    assert.ok(await run('Math.abs(reflowList().scrollHeight - reflowList().clientHeight - reflowList().scrollTop) < 2'),
      'opening a reply link and closing its tab keeps the result at the bottom');

    // A single long message can span many screens; message-level offsets are
    // insufficient when an image above the reading point changes size.
    await run(`{ const list = reflowList(), image = list.querySelector('.assistant-final-answer img');
      reflowDetach(list.scrollTop + image.getBoundingClientRect().top - list.getBoundingClientRect().top + image.getBoundingClientRect().height * .4); }
      window.reflowImagePosition = () => { const image = reflowList().querySelector('img').getBoundingClientRect();
        return (reflowList().getBoundingClientRect().top + 20 - image.top) / image.height; }; void 0;`);
    await pause(200);
    const imagePoint = await run('reflowImagePosition()');
    for (const width of [370, 580, 900, 370, 900]) {
      await run(`reflowWidth(${width})`); await pause(160);
      assert.ok(Math.abs(await run('reflowImagePosition()') - imagePoint) < .015,
        'resizing preserves the viewed part of a tall image at width ' + width);
    }

    await run(`window.reflowText = [...reflowList().querySelectorAll('.assistant-final-answer p')].find(p => p.textContent.startsWith('Template details'));
      reflowDetach(reflowList().scrollTop + reflowText.getBoundingClientRect().top - reflowList().getBoundingClientRect().top + 85);`);
    await pause(200);
    const top = await run('reflowList().scrollTop');
    await run(`updateChat({ messages: reflowMessages.map(message => message.role === 'assistant'
      ? { ...message, content: message.content.replace('\\n\\nThe final result', ' Appended details.'.repeat(12) + '\\n\\nThe final result') } : message) })`);
    await pause(200);
    await run('reflowWidth(370)'); await pause(250);
    await run('reflowWidth(900)'); await pause(250);
    assert.ok(Math.abs(await run('reflowList().scrollTop') - top) < 3, 'text line keeps its character anchor after appending text and resizing');

    // A new scroll while split supersedes the previous reading point.
    await run('reflowWidth(370)'); await pause(250);
    await run(`{ const list = reflowList(), image = list.querySelector('img').getBoundingClientRect();
      reflowDetach(list.scrollTop + image.top - list.getBoundingClientRect().top + image.height * .2); }`);
    await pause(150);
    const newImagePoint = await run('reflowImagePosition()');
    await run('reflowWidth(900)'); await pause(250);
    const afterManualResize = await run('reflowImagePosition()');
    assert.ok(Math.abs(afterManualResize - newImagePoint) < .015,
      'manual reading in the split view is respected: ' + newImagePoint + ' -> ' + afterManualResize);
    console.log('Conversation reflow passed: link/tab roundtrip, image/line anchors, repeated resizing and manual reading.');
  } finally {
    await run('removeEventListener("cardbush:open-inspector", reflowOpen); document.querySelector(".chat-panel").style.removeProperty("width"); updateChat(reflowSaved)');
  }
};
