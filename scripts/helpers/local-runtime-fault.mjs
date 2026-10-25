import { isMainThread } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';

// Only loaded by isolated lifecycle tests, never by the installed launcher.
if (isMainThread) {
  const threads = createRequire(import.meta.url)('node:worker_threads');
  const Worker = threads.Worker;
  let runtime;
  threads.Worker = class extends Worker {
    constructor(filename, options) {
      super(filename, options);
      if (!String(filename).endsWith('/runtimeHostWorker.mjs')) return;
      runtime = this;
      const timer = setInterval(() => {
        if (process.env.CARDBUSH_TEST_WORKER_EXIT && existsSync(process.env.CARDBUSH_TEST_WORKER_EXIT)) {
          clearInterval(timer); void this.terminate();
        }
      }, 25).unref();
      this.once('exit', () => clearInterval(timer));
    }
  };
  syncBuiltinESMExports();
  const { AgentService } = await import('../../dist-electron/agentService.mjs');
  const open = AgentService.open;
  AgentService.open = async function (options) {
    const service = await open.call(this, { ...options, toolsEnabled: false });
    if (process.env.CARDBUSH_TEST_EXIT_DURING_STARTUP === '1') {
      await runtime.terminate(); await service.runtime.failure;
    }
    return service;
  };
}
