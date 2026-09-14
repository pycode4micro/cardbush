import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
const require = createRequire(import.meta.url);
const { ModelPreviewService, findBlenderExecutable } = require('../dist-electron/modelPreview.js');
const run = promisify(execFile);
const scriptPath = path.resolve('assets/previewers/blender_preview.py');
const executable = await findBlenderExecutable();
const hash = data => createHash('sha256').update(data).digest('hex');

test('adapter rejects unregistered input and never treats missing executable configuration as a default', async () => {
  const service = new ModelPreviewService({ scriptPath });
  try {
    await assert.rejects(service.preview('relative.blend'), { code: 'unsupported' });
    await assert.rejects(service.preview(path.resolve('notes.txt')), { code: 'unsupported' });
    const cancelledId = randomUUID();
    await service.release(cancelledId);
    await assert.rejects(service.preview(path.resolve('not-yet-opened.blend'), '', undefined, cancelledId), { code: 'cancelled' });
    await assert.rejects(service.preview(path.resolve('file.blend'), '', undefined, '../outside'), { code: 'invalid_request' });
    assert.equal(await findBlenderExecutable({ CARDBUSH_BLENDER_PATH: path.resolve('missing-blender-executable') }), null);
  } finally { await service.dispose(); }
});

test('preview command keeps bounded logs and stops descendants on release without needing Blender', { timeout: 15000 }, async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'cardbush-preview-process-test-'));
  const helper = path.join(scratch, 'preview-fixture.cjs');
  const file = path.join(scratch, 'fixture.blend');
  const host = require('../dist-electron/hostProcesses.js');
  const runHostCommand = host.runHostCommand;
  const service = new ModelPreviewService({ scriptPath, executable: process.execPath, tempRoot: scratch });
  try {
    await fs.writeFile(file, 'fixture input');
    await fs.writeFile(helper, `const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2), split=args.indexOf('--'), file=args[split+1], dir=args[split+2], scene=args[args.indexOf('--scene')+1];
if(scene==='hold') {
const child=require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},10000)'],{stdio:'ignore',windowsHide:true});
fs.writeFileSync(file+'.pids',JSON.stringify([process.pid,child.pid]));setTimeout(()=>{},10000);
} else if(scene==='fail') { console.error('fixture conversion failed'); process.exitCode=7; }
else { for(let i=0;i<64;i++)process.stdout.write('x'.repeat(65536));
fs.writeFileSync(path.join(dir,'scene.glb'),'glTF fixture');
fs.writeFileSync(path.join(dir,'metadata.json'),JSON.stringify({scene:'Fixture',scenes:['Fixture'],issues:[]})); }`);
    // Replace only the Blender executable with a fixture. Launching, resource
    // protection, output receipt, cancellation and cleanup use production code.
    host.runHostCommand = options => {
      assert.ok(options.args.includes('--disable-autoexec'));
      assert.equal(options.env.PYTHONNOUSERSITE, '1');
      return runHostCommand({ ...options, args: [helper, ...options.args] });
    };
    const prepared = await service.preview(file);
    assert.equal(prepared.metadata.scene, 'Fixture');
    await service.release(prepared.id);
    await assert.rejects(service.preview(file, 'fail'), { code: 'conversion' });
    const id = randomUUID();
    const pending = service.preview(file, 'hold', undefined, id);
    const cancelled = assert.rejects(pending, { code: 'cancelled' });
    let pids;
    const deadline = Date.now() + 5000;
    while (!pids && Date.now() < deadline) {
      try { pids = JSON.parse(await fs.readFile(file + '.pids', 'utf8')); } catch { await delay(20); }
    }
    assert.ok(pids, 'fixture started a real descendant');
    await service.release(id);
    await cancelled;
    for (const pid of pids) {
      let alive = true;
      for (let attempt = 0; attempt < 100 && alive; attempt++) {
        try { process.kill(pid, 0); await delay(20); } catch { alive = false; }
      }
      assert.equal(alive, false, `preview process ${pid} survived release`);
    }
    assert.equal(await fs.readFile(file, 'utf8'), 'fixture input');
  } finally {
    host.runHostCommand = runHostCommand;
    await service.dispose();
    assert.equal(path.dirname(path.resolve(scratch)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(scratch).startsWith('cardbush-preview-process-test-'));
    await fs.rm(scratch, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('real Blender preview: compressed/uncompressed scenes, animation, textures, read-only source, failures and cleanup', { skip: !executable, timeout: 120000 }, async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'cardbush-model-test-'));
  const service = new ModelPreviewService({ scriptPath, executable, tempRoot: scratch });
  const timeoutService = new ModelPreviewService({ scriptPath, executable, tempRoot: scratch, timeoutMs: 50 });
  try {
    await run(executable, ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--python', path.resolve('scripts/fixtures/create-blender-preview-fixture.py'), '--', scratch], { windowsHide: true, timeout: 45000 });
    for (const name of ['scene.blend', 'uncompressed.blend']) {
      const file = path.join(scratch, name);
      const original = await fs.readFile(file);
      const result = await service.preview(file);
      assert.deepEqual(result.metadata.scenes, ['Animated scene', 'Second scene']);
      assert.equal(result.metadata.scene, 'Animated scene');
      const artifact = service.resource(result.id);
      assert.ok(path.relative(scratch, artifact).startsWith('cardbush-model-preview-'));
      const buffer = await fs.readFile(artifact);
      assert.equal(buffer.subarray(0, 4).toString(), 'glTF');
      const document = JSON.parse(buffer.subarray(20, 20 + buffer.readUInt32LE(12)).toString());
      assert.ok(document.animations.length >= 1, 'Blender animations reach the viewer');
      assert.ok(document.images.some(image => image.bufferView !== undefined), 'textures are embedded, not fetched from external locations');
      assert.ok(document.meshes.some(mesh => mesh.primitives.some(primitive => primitive.targets?.length)), 'shape keys survive preview conversion');
      assert.equal(hash(await fs.readFile(file)), hash(original), 'preview does not change any source byte');
      await service.release(result.id);
      assert.equal(service.resource(result.id), undefined);
      await assert.rejects(fs.stat(artifact), { code: 'ENOENT' });
    }
    await assert.rejects(fs.stat(path.join(scratch, 'embedded-script-ran')), { code: 'ENOENT' });
    const file = path.join(scratch, 'scene.blend');
    const second = await service.preview(file, 'Second scene');
    assert.equal(second.metadata.scene, 'Second scene');
    assert.equal(second.metadata.objects, 1);
    await service.release(second.id);
    await assert.rejects(service.preview(file, 'Deleted scene'), { code: 'conversion' });
    await fs.writeFile(path.join(scratch, 'corrupt.blend'), 'This is not a Blender file.');
    await assert.rejects(service.preview(path.join(scratch, 'corrupt.blend')), { code: 'conversion' });
    await assert.rejects(timeoutService.preview(file), { code: 'timeout' });
    const controller = new AbortController();
    const pending = service.preview(file, '', controller.signal);
    const timer = setTimeout(() => controller.abort(), 200);
    await assert.rejects(pending, { code: 'cancelled' });
    clearTimeout(timer);
    const requestId = randomUUID();
    const explicitlyCancelled = service.preview(file, '', undefined, requestId);
    await service.release(requestId);
    await assert.rejects(explicitlyCancelled, { code: 'cancelled' });
    const concurrent = [service.preview(file), service.preview(file)];
    await new Promise(resolve => setTimeout(resolve, 200));
    await service.dispose();
    for (const result of await Promise.allSettled(concurrent)) {
      assert.equal(result.status, 'rejected');
      assert.equal(result.reason.code, 'cancelled');
    }
    assert.equal((await fs.readdir(scratch)).filter(name => name.startsWith('cardbush-model-preview-')).length, 1, 'only the still-live timeout service retains its empty root');
  } finally {
    await service.dispose(); await timeoutService.dispose();
    const normalized = path.resolve(scratch);
    assert.equal(path.dirname(normalized), path.resolve(os.tmpdir()));
    assert.ok(path.basename(normalized).startsWith('cardbush-model-test-'));
    await fs.rm(normalized, { recursive: true, force: true });
  }
});
