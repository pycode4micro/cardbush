import { readFile, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const [work, outside, reference, port] = process.argv.slice(2);
const probe = async (name, action) => {
  try { await action(); console.log(`${name}=allowed`); }
  catch (error) { console.log(`${name}=${error.code || error.name}`); }
};
await probe('insideWrite', () => writeFile(join(work, 'inside.txt'), 'allowed'));
await probe('outsideWrite', () => writeFile(join(outside, 'outside.txt'), 'unexpected'));
await probe('outsideRead', () => readFile(join(outside, 'secret.txt')));
await probe('readOnlyRead', () => readFile(join(reference, 'reference.txt')));
await probe('readOnlyWrite', () => writeFile(join(reference, 'changed.txt'), 'unexpected'));
await probe('linkedWrite', () => writeFile(join(work, 'escape', 'linked.txt'), 'unexpected'));
await probe('network', () => new Promise((resolve, reject) => {
  const socket = connect({ host: '127.0.0.1', port: Number(port) });
  socket.once('connect', () => { socket.destroy(); resolve(); });
  socket.once('error', reject);
  socket.setTimeout(1500, () => { socket.destroy(); reject(Error('timeout')); });
}));
console.log(`hostSecret=${process.env.CARDBUSH_TEST_SECRET ?? 'absent'}`);
console.log(`nodeOptions=${process.env.NODE_OPTIONS ?? 'absent'}`);
const child = spawnSync(process.execPath, ['-e', `require('fs').writeFileSync(process.argv[1], 'unexpected')`, join(outside, 'child.txt')], { encoding: 'utf8' });
console.log(`childOutsideWrite=${child.status === 0 ? 'allowed' : 'denied'}`);
