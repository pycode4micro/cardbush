import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const npmCli = process.env.npm_execpath;
const testScripts = Object.keys(packageJson.scripts).filter(
  (name) => name.startsWith('test:') && name !== 'test:all',
);

for (const script of [...testScripts, 'typecheck', 'build']) {
  const command = npmCli ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const args = npmCli ? [npmCli, 'run', script] : ['run', script];
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    stdio: 'inherit',
    shell: false,
  });
  if (result.status !== 0) {
    if (result.error) console.error(result.error);
    process.exit(result.status ?? 1);
  }
}

const packagedContract = spawnSync(
  process.execPath,
  ['scripts/test-release-cleanup-contract.mjs', '--dist'],
  {
    cwd: repositoryRoot,
    stdio: 'inherit',
    shell: false,
  },
);
process.exit(packagedContract.status ?? 1);
