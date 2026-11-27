const { spawn } = require('node:child_process');

function launchElectronFixture(executable, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(process.stdout, { end: false });
    child.stderr.pipe(process.stderr, { end: false });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === null) reject(new Error(`Electron fixture exited without a status (${signal})`));
      else resolve(code);
    });
  });
}

// Finish the fixture and its window teardown before choosing the process result.
// Electron otherwise starts quitting inside destruction of the last window.
function runElectronFixture(app, run) {
  app.on('window-all-closed', () => {});
  return app.whenReady().then(run).then(
    () => app.quit(),
    error => {
      console.error(error);
      app.exit(1);
    },
  );
}

module.exports = { launchElectronFixture, runElectronFixture };
