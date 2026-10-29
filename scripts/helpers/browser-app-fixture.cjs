// Real desktop entry point, with every writable profile location isolated.
const { app, powerMonitor, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(process.env.CARDBUSH_BROWSER_TEST_ROOT || '');
const repo = path.resolve(__dirname, '../..');
if (!root.startsWith(path.join(repo, 'tmp') + path.sep) || !path.basename(root).startsWith('browser-reconnect-native-')) {
  throw new Error('An isolated browser test root is required');
}
for (const name of ['userData', 'sessionData', 'appData', 'temp', 'desktop', 'documents', 'downloads', 'logs']) {
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { recursive: true });
  app.setPath(name, directory);
}
app.setAppPath(repo);
process.chdir(root);
app.on('browser-window-created', (_event, window) => { window.show = () => {}; window.showInactive = () => {}; });
// Test profiles must never create Start Menu shortcuts in the operator's account.
shell.writeShortcutLink = () => false;
process.on('message', message => {
  if (message === 'quit') app.quit();
  if (message === 'resume') powerMonitor.emit('resume');
});
require(path.join(repo, 'dist-electron/main.js'));
