import { app, protocol } from 'electron';
import { mkdtempSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// Export processes use a private profile and do not initialize the desktop,
// its single-instance lock, conversations, providers or user settings.
if (process.argv.includes('--cardbush-presentation-export')) {
  const flag = process.argv.indexOf('--cardbush-presentation-export');
  // The job owner also removes this profile after the process exits, when
  // Chromium's Windows file handles have finally been released.
  app.setPath('userData', mkdtempSync(join(dirname(resolve(process.argv[flag + 1])), '.cardbush-presentation-export-')));
  app.on('window-all-closed', () => { /* Exit explicitly after writing the receipt. */ });
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  protocol.registerSchemesAsPrivileged([{ scheme: 'cardbush-file', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
  void import('./presentationExport.js').then(module => module.runPresentationExport());
} else {
  // Desktop protocol registration and command-line switches must still run
  // synchronously before Electron becomes ready.
  require('./main.js');
}
