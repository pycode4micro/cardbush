import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

async function savedFile(file: string) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

/** Only choose when to boot the owner. Runtime still evaluates and consumes every detection. */
export async function residentRuntimeWakeAt(root: string, now = Date.now()): Promise<number | undefined> {
  try {
    const [friends, scheduler] = await Promise.all([savedFile(join(root, 'friends', 'events.json')), savedFile(join(root, 'scheduler', 'automations.json'))]);
    const deadlines: number[] = [];
    if (friends) {
      if (friends.version !== 1) return now;
      const live = new Set(friends.events.filter((e: { status: string }) => !['paused', 'failed'].includes(e.status)).map((e: { id: string }) => e.id));
      if (friends.active || friends.notifications?.length || friends.signals.some((s: { eventId: string }) => live.has(s.eventId))) return now;
      for (const timer of friends.detections) if (live.has(timer.eventId)) deadlines.push(Date.parse(timer.at));
    }
    if (scheduler) {
      if (scheduler.version !== 1) return now;
      for (const job of scheduler.jobs) {
        if (job.runs?.some((run: { status: string }) => ['running', 'queued'].includes(run.status))) return now;
        if (job.state === 'active') {
          if (!job.nextRunAt) return now;
          deadlines.push(Date.parse(job.nextRunAt));
        }
      }
    }
    if (!deadlines.length) return undefined;
    const earliest = deadlines.reduce((a, b) => Math.min(a, b), Infinity);
    return Number.isFinite(earliest) ? Math.max(now, earliest - 15_000) : now;
  } catch { return now; } // Let the authoritative store validate and recover unusual state.
}
