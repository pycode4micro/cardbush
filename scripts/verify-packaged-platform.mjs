import { spawnSync } from 'node:child_process';
import path from 'node:path';
const directory = path.resolve(process.argv[2] ?? `release-smoke/${process.platform === 'win32' ? 'win-unpacked' : 'linux-unpacked'}`);
const run = args => {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};
run(['scripts/run-packaged-smoke.mjs', path.join(directory, process.platform === 'win32' ? 'CardBush.exe' : 'cardbush')]);
if (process.platform === 'win32') {
  run(['scripts/test-chrome-native-host.mjs', path.join(directory, 'resources/chrome-native-host/CardBushBrowserHost.exe')]);
}
run(['scripts/test-chrome-connector-contract.mjs', directory]);
