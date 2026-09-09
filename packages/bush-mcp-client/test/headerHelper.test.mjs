import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { mcpHeaderFetch } from '../dist/headerHelper.js';

test('header helpers cache credentials, refresh once, preserve explicit authorization and never inject into another origin', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-header-test-'));
  try {
    const script = join(root, 'headers.cjs'), counter = join(root, 'count');
    await writeFile(script, `const fs=require('fs');const file=${JSON.stringify(counter)};const n=Number(fs.existsSync(file)?fs.readFileSync(file,'utf8'):0)+1;fs.writeFileSync(file,String(n));process.stdout.write(JSON.stringify({'X-Plugin-Key':'fixture-'+n,'Authorization':'helper-bearer'}));`);
    const quote = value => `'${value.replaceAll("'", process.platform === 'win32' ? "''" : "'\\''")}'`;
    const command = `${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)} ${quote(script)}`;
    const seen = [];
    const fetcher = mcpHeaderFetch('https://mcp.example/mcp', { command, cwd: root, env: {} }, async (input, init) => {
      const headers = new Headers(init?.headers); seen.push({ url: String(input), headers: Object.fromEntries(headers), redirect: init?.redirect });
      return new Response('', { status: headers.get('x-plugin-key') === 'fixture-1' ? 401 : 200 });
    });
    await fetcher('https://mcp.example/mcp', { headers: { Authorization: 'explicit-token' } });
    assert.equal(seen.length, 2); assert.ok(seen.every(item => item.headers.authorization === 'explicit-token'));
    assert.equal(seen[1].headers['x-plugin-key'], 'fixture-2');
    assert.equal(seen[1].redirect, 'error');
    await fetcher('https://mcp.example/mcp');
    assert.equal(await readFile(counter, 'utf8'), '2');
    await fetcher('https://auth.example/token');
    assert.equal(seen.at(-1).headers['x-plugin-key'], undefined);
  } finally { assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(root.includes('cardbush-header-test-')); await rm(root, { recursive: true, force: true }); }
});
