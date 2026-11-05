import { isMainThread } from 'node:worker_threads';
import { existsSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

// Only loaded by isolated lifecycle tests, never by the installed launcher.
if (basename(process.argv[1] ?? '') === 'runtimeHostWorker.mjs') {
  if (process.env.CARDBUSH_TEST_RUNTIME_PID) writeFileSync(process.env.CARDBUSH_TEST_RUNTIME_PID, String(process.pid));
  const trigger = process.env.CARDBUSH_TEST_WORKER_EXIT;
  if (trigger) setInterval(() => { if (existsSync(trigger)) process.exit(1); }, 25).unref();
} else if (isMainThread) {
  const { AgentService } = await import('../../dist-electron/agentService.mjs');
  const open = AgentService.open;
  AgentService.open = async function (options) {
    const trigger = process.env.CARDBUSH_TEST_WORKER_EXIT ?? join(options.dataRoot, 'exit-worker');
    const service = await open.call(this, { ...options, toolsEnabled: false,
      env: { ...options.env, CARDBUSH_TEST_WORKER_EXIT: trigger,
        ...(process.env.CARDBUSH_TEST_RUNTIME_PID ? { CARDBUSH_TEST_RUNTIME_PID: process.env.CARDBUSH_TEST_RUNTIME_PID } : {}) } });
    if (process.env.CARDBUSH_TEST_EXIT_DURING_STARTUP === '1') {
      writeFileSync(trigger, '');
      await service.runtime.failure;
    }
    return service;
  };
}
