const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { ipcMain } = require('electron');
const { pathToFileURL } = require('node:url');

module.exports = async ({ run, until, pause, window, root }) => {
  const { PastedTextAttachments } = await import(pathToFileURL(path.join(root, 'dist-electron/pastedTextAttachments.mjs')).href);
  const parent = path.join(root, 'tmp'); await fs.mkdir(parent, { recursive: true });
  const testRoot = await fs.mkdtemp(path.join(parent, 'paste-ui-'));
  const stores = { local: new PastedTextAttachments(path.join(testRoot, 'local')), remote: new PastedTextAttachments(path.join(testRoot, 'remote')) };
  const events = [], created = [];
  ipcMain.handle('fixture-pasted-text', async (_, host, action, input) => {
    events.push([host, action]);
    const value = await stores[host][action](input);
    if (action === 'create') created.push(value);
    return value;
  });
  try {
    await run(`
      // The isolated data: fixture has no secure-context randomUUID; production does.
      if (!crypto.randomUUID) crypto.randomUUID = require('node:crypto').randomUUID;
      window.pasteDrafts = { a: '保留原有草稿' }; window.pasteSession = 'a'; window.pasteRemote = false;
      window.pasteSent = []; window.pastePreviews = []; window.pasteSendOk = true;
      window.pasteApi = host => ({
        create: async text => {
          if (window.pasteFail) throw Error('fixture disk failure');
          if (window.pasteDelay) await new Promise(resolve => { window.releasePaste = resolve; });
          return require('electron').ipcRenderer.invoke('fixture-pasted-text', host, 'create', text);
        },
        retain: ids => require('electron').ipcRenderer.invoke('fixture-pasted-text', host, 'retain', ids),
        discard: id => require('electron').ipcRenderer.invoke('fixture-pasted-text', host, 'discard', id),
      });
      cardbushDesktop.pastedTextAttachments = pasteApi('local');
      window.pasteMount = () => {
        const id = pasteSession;
        const host = pasteRemote ? { id: 'agent:' + id, plugins: [], pluginCommands: [], uploadFiles: async () => [],
          pastedTextAttachments: pasteApi('remote'), openFile: path => pastePreviews.push(path) } : undefined;
        renderView(h(views.ConversationHostContext.Provider, { value: host },
          h(views.ComposerReferenceContext.Provider, { value: { sessionId: id, messages: [], browserTabs: [] } },
            h('div', { style: { padding: '50px', width: '100%' } }, h(views.Composer, { ...chatProps,
              language: window.pasteLanguage || 'zh', sending: false, submissionPending: false, inputReadOnly: !!window.pasteReadOnly,
              draft: pasteDrafts[id] || '', onDraftChange: value => { pasteDrafts[id] = value; pasteMount(); },
              onSend: async text => { pasteSent.push(text); return pasteSendOk; },
            })))));
      };
      window.pasteText = text => {
        const node = document.querySelector('[data-composer-input]'); node.focus();
        const data = new DataTransfer(); data.setData('text/plain', text);
        const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data });
        node.dispatchEvent(event); return event.defaultPrevented;
      };
      window.pasteSend = () => document.querySelector('[data-composer-input]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      addEventListener('cardbush:open-inspector', event => pastePreviews.push(event.detail.target));
      pasteMount();
    `);
    await until('!!document.querySelector("textarea[data-composer-input]")', 'plain composer');
    assert.equal(await run('pasteText("short paste")'), false, 'ordinary paste keeps native behavior');
    await run(`
      window.pasteImageSaves = 0;
      cardbushDesktop.saveImageDataUrl = async () => { pasteImageSaves++; return { path: 'D:/fixture/paste.png', name: 'paste.png' }; };
      const data = new DataTransfer();
      data.items.add(new File([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a+QAAAABJRU5ErkJggg=='), value => value.charCodeAt(0))], 'paste.png', { type: 'image/png' }));
      data.setData('text/plain', 'image text'.repeat(1000));
      document.querySelector('[data-composer-input]').dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
    `);
    await until('!!document.querySelector(".composer-image-thumb")', 'image paste keeps the image attachment flow');
    assert.equal(created.length, 0, 'image paste is not mistaken for long text');
    assert.equal(await run('pasteImageSaves'), 1);
    await run('document.querySelector(".composer-image-remove").click()');
    assert.equal(await run('pasteText("字符".repeat(5000))'), true);
    await until('document.querySelectorAll("[data-pasted-text]").length === 1', 'long paste card');
    assert.equal(await run('pasteDrafts.a'), '保留原有草稿');
    assert.equal(await fs.readFile(created[0].path, 'utf8'), '字符'.repeat(5000));
    assert.ok((await run('document.querySelector(".composer-pasted-text-preview").textContent')).length <= 160);
    await run('document.querySelector(".composer-file-preview").click()');
    assert.equal(await run('pastePreviews[0]'), created[0].path);
    await run('document.querySelector(".composer-file-remove").click()');
    await until('!document.querySelector("[data-pasted-text]")', 'remove unsent card');
    await assert.rejects(fs.stat(created[0].path), { code: 'ENOENT' });

    await run('window.pasteDelay = true; pasteText("line\\r\\n".repeat(201)); pasteSend();');
    await until('!!window.releasePaste', 'paste pending');
    assert.equal(await run('pasteSent.length'), 0, 'Enter during save does not send incomplete attachments');
    await run('pasteSession = "b"; pasteDrafts.b = "另一会话"; pasteMount()');
    await until('document.querySelector("textarea")?.value === "另一会话"', 'switch during save');
    await run('window.pasteDelay = false; releasePaste()');
    await until('!document.querySelector(".composer-attachment-progress")', 'other session is idle');
    await pause(150);
    assert.equal(await run('document.querySelectorAll("[data-pasted-text]").length'), 0);
    await run('pasteSession = "a"; pasteMount()');
    await until('!!document.querySelector("[data-pasted-text]") && !document.querySelector(".composer-attachment-progress")', 'original draft restored');
    assert.match(await run('document.querySelector(".composer-file-meta").textContent'), /202 行/);
    await run('pasteSend()');
    await until('pasteSent.length === 1 && !document.querySelector("[data-pasted-text]")', 'local send');
    assert.ok(events.findIndex(event => event[1] === 'retain') >= 0);
    assert.equal(await run('pasteSent[0]'), '@' + created[1].path + '\n保留原有草稿');
    assert.equal(await fs.readFile(created[1].path, 'utf8'), 'line\r\n'.repeat(201));

    await run('pasteDrafts.a = "[fixture](<D:/skills/fixture/SKILL.md>) keep"; pasteMount()');
    await until('!!document.querySelector(".composer-prompt-editor")', 'rich composer');
    assert.equal(await run('pasteText("rich".repeat(3000))'), true);
    await until('!!document.querySelector("[data-pasted-text]")', 'rich long paste');
    assert.equal(await run('pasteDrafts.a'), '[fixture](<D:/skills/fixture/SKILL.md>) keep');
    assert.doesNotMatch(await run('document.querySelector(".composer-prompt-editor").textContent'), /richrich/);
    await run('document.querySelector(".composer-file-remove").click()');
    await until('!document.querySelector("[data-pasted-text]")', 'rich remove');

    const beforeError = await run('errorDialogs.length');
    await run('window.pasteFail = true; pasteText("failure".repeat(2000))');
    await until('errorDialogs.length > ' + beforeError, 'visible save failure');
    assert.equal(await run('pasteDrafts.a'), '[fixture](<D:/skills/fixture/SKILL.md>) keep');
    await run('window.pasteFail = false; window.pasteReadOnly = true; pasteMount()');
    await pause(50);
    await run('pasteText("readonly".repeat(2000))');
    await pause(50);
    assert.equal(created.length, 3, 'read-only input rejects attachment creation');

    await run('window.pasteReadOnly = false; pasteRemote = true; pasteSession = "remote"; pasteDrafts.remote = "Remote instruction"; pasteLanguage = "en"; pasteMount()');
    await until('document.querySelector("textarea")?.value === "Remote instruction"', 'remote composer');
    await run('pasteText("remote content".repeat(1000))');
    await until('!!document.querySelector("[data-pasted-text]")', 'remote text card');
    assert.match(created[3].path, /remote/);
    assert.match(await run('document.querySelector(".composer-file-meta").textContent'), /Pasted text.*1 line/);
    await run('document.querySelector(".composer-file-preview").click()');
    assert.equal(await run('pastePreviews.at(-1)'), created[3].path);
    await run('pasteSendOk = false; pasteSend()');
    await until('pasteSent.length === 2 && !document.querySelector(".composer-attachment-progress")', 'rejected remote send');
    assert.equal(await run('document.querySelectorAll("[data-pasted-text]").length'), 1, 'rejected send keeps retryable card');
    assert.equal(await run('pasteDrafts.remote'), 'Remote instruction');
    await run('pasteSendOk = true; pasteSend()');
    await until('pasteSent.length === 3 && !document.querySelector("[data-pasted-text]")', 'remote retry accepted');
    assert.equal(await run('pasteSent[2]'), '@' + created[3].path + '\nRemote instruction');

    for (const theme of ['theme-light', 'theme-dark']) {
      await run('window.viewTheme = ' + JSON.stringify(theme) + '; pasteMount()');
      await run('pasteText("视觉预览 / Preview\\n".repeat(220))');
      await until('!!document.querySelector("[data-pasted-text]") && !document.querySelector(".composer-attachment-progress")', 'theme preview');
      await pause(100);
      await fs.writeFile(path.join(parent, 'pasted-text-' + theme + '.png'), (await window.webContents.capturePage()).toPNG());
      assert.equal(await run('document.querySelector(".composer-file-strip").scrollWidth <= document.querySelector(".composer-file-strip").clientWidth + 1'), true);
      await run('document.querySelector(".composer-file-remove").click()');
      await until('!document.querySelector("[data-pasted-text]")', 'theme remove');
    }
    console.log('Pasted text UI passed: native/rich paste, exact files, preview/removal, pending send, conversation switching, failures, remote retry and both themes.');
  } catch (error) {
    console.error('Paste fixture diagnostics:', events, await run('JSON.stringify({ errors: errorDialogs, randomUUID: typeof crypto.randomUUID })'));
    throw error;
  } finally {
    ipcMain.removeHandler('fixture-pasted-text');
    assert.ok(path.resolve(testRoot).startsWith(path.resolve(parent) + path.sep));
    await fs.rm(testRoot, { recursive: true, force: true });
  }
};
