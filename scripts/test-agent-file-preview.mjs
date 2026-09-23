import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentFilePreviews } from '../dist-electron/agentFilePreview.mjs';
import { agentFileRead } from '../dist-electron/agentFiles.mjs';

test('remote preview preserves paths, dependencies and workspace confinement', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-agent-preview-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace'); await mkdir(join(workspace, 'charts'), { recursive: true });
  await writeFile(join(workspace, 'charts/报表 #1%.html'), '<h1>远程图表</h1>');
  await writeFile(join(workspace, 'data.json'), '{"value":42}');
  await writeFile(join(root, 'secret.txt'), 'must not leak');
  await symlink(root, join(workspace, 'outside'), process.platform === 'win32' ? 'junction' : 'dir');
  const reads = [];
  const preview = new AgentFilePreviews(async (id, input) => {
    assert.equal(id, 'agent-a'); assert.equal(input.sessionId, 'session-a'); reads.push(input.path);
    return agentFileRead(workspace, input);
  }, path => path.endsWith('.html') ? 'text/html' : 'application/json');
  const grant = preview.create(1, 'agent-a', 'session-a', 'charts/报表 #1%.html');
  assert.match(grant.url, /^cardbush-agent:\/\/[\w-]+\/charts\//);
  const page = await preview.respond(new Request(grant.url));
  assert.equal(page.status, 200); assert.equal(await page.text(), '<h1>远程图表</h1>');
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.ok(!page.headers.get('content-security-policy').includes('file:'));
  assert.equal(await (await preview.respond(new Request(new URL('../data.json', grant.url)))).text(), '{"value":42}');
  for (const path of ['/../secret.txt', '/outside/secret.txt', '/%2e%2e%2fsecret.txt']) {
    assert.equal((await preview.respond(new Request(new URL(path, grant.url)))).status, 404, path);
  }
  const absolute = preview.create(1, 'agent-a', 'session-a', join(workspace, 'charts/报表 #1%.html'));
  assert.equal(await (await preview.respond(new Request(absolute.url))).text(), '<h1>远程图表</h1>');
  preview.release(2, grant.id);
  assert.equal((await preview.respond(new Request(grant.url))).status, 200, 'another owner cannot revoke a preview');
  preview.releaseOwner(1);
  const count = reads.length;
  assert.equal((await preview.respond(new Request(grant.url))).status, 404);
  assert.equal((await preview.respond(new Request(absolute.url))).status, 404);
  assert.equal(reads.length, count, 'expired URLs never read the Agent');
  assert.throws(() => preview.create(1, 'a', 's', 'https://example.com/secret'));
});

test('large remote resources stream with ranges, HEAD and cancellation', async () => {
  const bytes = Buffer.alloc(1_400_000); for (let i=0;i<bytes.length;i++) bytes[i]=i%251;
  const offsets = [];
  const preview = new AgentFilePreviews(async (_id, { offset }) => {
    offsets.push(offset); const part = bytes.subarray(offset, offset+512*1024);
    return { name: 'movie.mp4', size: bytes.length, offset, content: part.toString('base64'), done: offset+part.length===bytes.length };
  }, () => 'video/mp4');
  const { url, id } = preview.create(1, 'a', 's', '/srv/movie.mp4');
  assert.deepEqual(Buffer.from(await (await preview.respond(new Request(url))).arrayBuffer()), bytes);
  assert.ok(offsets.length >= 3);
  for (const [range, start, end] of [['bytes=524200-524400',524200,524400], ['bytes=-80',bytes.length-80,bytes.length-1], ['bytes=1048576-',1048576,bytes.length-1]]) {
    const response = await preview.respond(new Request(url, { headers: { range } }));
    assert.equal(response.status,206); assert.equal(response.headers.get('content-range'),`bytes ${start}-${end}/${bytes.length}`);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes.subarray(start,end+1));
  }
  assert.equal((await preview.respond(new Request(url,{headers:{range:'bytes=999999999-'}}))).status,416);
  offsets.length=0;
  assert.equal(await (await preview.respond(new Request(url,{method:'HEAD'}))).text(),'');
  assert.deepEqual(offsets,[0]);
  assert.equal((await preview.respond(new Request(url,{method:'POST'}))).status,405);
  const cancelled = (await preview.respond(new Request(url))).body.getReader();
  await cancelled.read(); await cancelled.cancel();
  const count = offsets.length;
  await new Promise(resolve => setTimeout(resolve,20));
  assert.equal(offsets.length,count,'cancelled streams do not keep reading remote chunks');
  const response = await preview.respond(new Request(url));
  preview.release(1,id);
  await assert.rejects(response.arrayBuffer(), /expired/);
});

test('malformed or disconnected file responses never fall back to local disk', async () => {
  for (const data of [{name:'x',size:2,offset:0,content:'',done:false}, {name:'x',size:1,offset:2,content:'YQ==',done:true}, null]) {
    const preview = new AgentFilePreviews(async () => data, () => 'text/plain');
    assert.equal((await preview.respond(new Request(preview.create(1,'a','s','C:/private.txt').url))).status,404);
  }
});
