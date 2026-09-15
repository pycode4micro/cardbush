import { app, webContents, type WebContents, type ProcessMetric } from 'electron';
import { freemem, totalmem } from 'node:os';

const MiB = 1024 ** 2;
let metricsAt = 0;
let metrics: ProcessMetric[] = [];
const guests = new Set<WebContents>();
let timer: ReturnType<typeof setInterval> | undefined;
let pressureSamples = 0;
let relievedAt = 0;
export function applicationMemoryMetrics(): ProcessMetric[] {
  if (Date.now() - metricsAt >= 2_000) { metrics = app.getAppMetrics(); metricsAt = Date.now(); }
  return metrics;
}
export function applicationMemoryBytes(): number {
  return applicationMemoryMetrics().reduce((total, metric) => total + metricMemoryBytes(metric), 0);
}
function metricMemoryBytes(metric: ProcessMetric): number { return (metric.memory.privateBytes ?? metric.memory.workingSetSize) * 1024; }
export function isLocalPreviewUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'file:' || parsed.protocol === 'cardbush-file:';
  } catch { return false; }
}

/** Called by the shared process governor before considering an executing task. */
export function relievePreviewForMemoryPressure(): boolean {
  if (relievedAt && Date.now() - relievedAt < 6_000) return true;
  return samplePreviews(true);
}

/** Best-effort renderer pressure relief. Native jobs enforce worker limits;
 * Electron owns renderer allocation, so a guest crash stays inside its preview. */
export function installPreviewResourceProtection(owner: WebContents): void {
  const owned = new Set<WebContents>();
  owner.on('did-attach-webview', (_event, guest) => {
    guests.add(guest); owned.add(guest);
    guest.once('destroyed', () => { guests.delete(guest); owned.delete(guest); stopIfIdle(); });
    if (!timer) { timer = setInterval(() => samplePreviews(), 2_000); timer.unref(); }
  });
  owner.once('destroyed', () => { for (const guest of owned) guests.delete(guest); owned.clear(); stopIfIdle(); });
}
function stopIfIdle(): void { if (!guests.size) { clearInterval(timer); timer = undefined; pressureSamples = 0; } }
function samplePreviews(forcePressure = false): boolean {
  try {
    const localGuests = [...guests].filter(guest => !guest.isDestroyed() && isLocalPreviewUrl(guest.getURL()));
    if (!localGuests.length) return false;
    const current = applicationMemoryMetrics();
    const byPid = new Map(localGuests.map(guest => [guest.getOSProcessId(), guest]));
    const consumers = current.filter(metric => byPid.has(metric.pid)).map(metric => ({ pid: metric.pid, bytes: metricMemoryBytes(metric) }))
      .sort((a, b) => b.bytes - a.bytes);
    const critical = freemem() < Math.min(512 * MiB, totalmem() * 0.025);
    pressureSamples = critical ? pressureSamples + 1 : 0;
    const largest = consumers[0];
    if (!largest || Date.now() - relievedAt < 6_000) return false;
    const perPreview = Math.min(1024 * MiB, Math.max(256 * MiB, totalmem() * 0.08));
    const combined = Math.min(2 * 1024 * MiB, totalmem() * 0.15);
    if (largest.bytes <= perPreview && consumers.reduce((sum, item) => sum + item.bytes, 0) <= combined
      && !((forcePressure || pressureSamples >= 2) && largest.bytes >= 128 * MiB)) return false;
    // Never terminate a process shared with a conversation or a remote browser tab.
    const sharing = webContents.getAllWebContents().filter(item => !item.isDestroyed() && item.getOSProcessId() === largest.pid);
    if (sharing.some(item => item.getType() !== 'webview' || !isLocalPreviewUrl(item.getURL()))) return false;
    const guest = byPid.get(largest.pid);
    if (guest && !guest.isDestroyed()) { relievedAt = Date.now(); guest.forcefullyCrashRenderer(); return true; }
    return false;
  } catch { return false; } // A guest may exit while Electron is collecting metrics.
}
