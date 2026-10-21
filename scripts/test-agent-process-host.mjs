import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, readFile, writeFile, access, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { AgentService } from '../dist-electron/agentService.mjs';
import { verifyProcessResourceHost } from '../packages/bush-runtime/dist/processes.js';

const base = resolve('tmp/agent-process-host-tests');
async function fixture(t) {
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'case-'));
  t.after(async () => { assert.ok(resolve(root).startsWith(base + sep)); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  return root;
}

test('Windows Agent refuses missing native assets before accepting tasks or changing service data', { skip: process.platform !== 'win32' }, async t => {
  const root = await fixture(t), dataRoot = join(root, 'data');
  const env = { CARDBUSH_PROCESS_HOST_PATH: '', CARDBUSH_PROCESS_HOST_DIRECTORY: join(root, 'missing') };
  await assert.rejects(AgentService.open({ dataRoot, env }), { code: 'resource_protection_unavailable' });
  await assert.rejects(access(dataRoot), { code: 'ENOENT' });
  // Explicit text-only mode does not need command execution components.
  const service = await AgentService.open({ dataRoot, env, toolsEnabled: false });
  try { assert.equal(service.info().capabilities.tools, false); } finally { await service.close(); }
});

test('Windows startup checks the configured executable, not a cached checkout host', { skip: process.platform !== 'win32' }, async t => {
  const root = await fixture(t), native = join(root, 'process-guard');
  await mkdir(native);
  const manifest = JSON.parse(await readFile(resolve('dist-native/process-guard/current.json'), 'utf8'));
  await cp(resolve('dist-native/process-guard/current.json'), join(native, 'current.json'));
  await cp(resolve('dist-native/process-guard', manifest.fileName), join(native, manifest.fileName));
  const env = { ...process.env, CARDBUSH_PROCESS_HOST_PATH: '', CARDBUSH_PROCESS_HOST_DIRECTORY: native };
  assert.equal(await verifyProcessResourceHost(env), join(native, manifest.fileName));
  await writeFile(join(native, manifest.fileName), 'invalid executable');
  await assert.rejects(verifyProcessResourceHost(env), { code: 'resource_protection_unavailable' });
});
