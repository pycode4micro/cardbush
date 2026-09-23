const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
module.exports = async ({ run, until, click, edit, window: win, root }) => {
    await click('模型管理');
    await until("document.querySelectorAll('.model-row').length === 2");
    assert.equal(await run("document.querySelector('.settings-switch input').checked"), false);
    await run("document.querySelector('.settings-switch input').click()");
    await until('settingsProps.visualInputEnabled === true');
    await edit('.model-row input', '500000');
    await run("document.querySelector('.model-context-save').click()");
    await until('settingsProps.settings.managedModelConfigs[0].maxContextTokens === 500000');
    for (const width of [1200, 1000, 760]) {
      win.setContentSize(width, 850); await pause(150);
      const bounds = await run(`Array.from(document.querySelectorAll('.model-row'), row => ({
        width: row.clientWidth, scroll: row.scrollWidth,
        inputs: Array.from(row.querySelectorAll('input'), input => { const r = input.getBoundingClientRect(), rowRect = row.getBoundingClientRect(); return { width: r.width, left: r.left - rowRect.left, right: rowRect.right - r.right }; })
      }))`);
      for (const row of bounds) {
        assert.ok(row.scroll <= row.width + 1, 'model row must fit width ' + width);
        for (const input of row.inputs) assert.ok(input.width >= 72 && input.left >= 0 && input.right >= 0, 'token controls remain readable and inside the row');
      }
      if (width === 1200) fs.writeFileSync(path.join(root, 'tmp/settings-model-limits.png'), (await win.webContents.capturePage()).toPNG());
    }
  console.log('Native model settings passed: vision, shared model rows, token editing and responsive layout.');
};
