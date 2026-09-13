import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { spawnResourceManagedProcess } from '../packages/bush-runtime/dist/index.js';

if (process.platform !== 'win32') throw new Error('This benchmark measures the Windows resource host.');
const samples = 12;
const eventLoop = monitorEventLoopDelay({ resolution: 10 });
eventLoop.enable();
async function run(executable, args, protectedRun) {
  const startedAt = performance.now();
  const guarded = protectedRun
    ? await spawnResourceManagedProcess({ executable, args, cwd: process.cwd() })
    : undefined;
  const child = guarded?.child ?? spawn(executable, args, { cwd: process.cwd(), windowsHide: true, stdio: 'pipe' });
  child.stdout.resume(); child.stderr.resume();
  const [code] = await once(child, 'close');
  const report = await guarded?.complete();
  if (code !== 0 || report?.code) throw new Error(`Benchmark command failed: ${code} ${JSON.stringify(report)}`);
  return performance.now() - startedAt;
}
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { p50Ms: +sorted[Math.floor(sorted.length / 2)].toFixed(2), p95Ms: +sorted[Math.ceil(sorted.length * .95) - 1].toFixed(2) };
}
const results = [];
for (const [shell, executable, args] of [
  ['cmd', process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'exit 0']],
  ['powershell', 'powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 0']],
]) {
  const baseline = [], protectedRuns = [];
  for (let i = 0; i < samples + 2; i++) {
    // Alternate order to avoid assigning all warm/cold cache effects to one side.
    const order = i % 2 ? [true, false] : [false, true];
    for (const protectedRun of order) {
      const elapsed = await run(executable, args, protectedRun);
      if (i >= 2) (protectedRun ? protectedRuns : baseline).push(elapsed);
    }
  }
  const normal = stats(baseline), guarded = stats(protectedRuns);
  results.push({ shell, samples, baseline: normal, protected: guarded, addedMedianMs: +(guarded.p50Ms - normal.p50Ms).toFixed(2) });
}
eventLoop.disable();
console.log(JSON.stringify({ results, runtimeEventLoopP99Ms: +(eventLoop.percentile(99) / 1e6).toFixed(2) }, null, 2));
