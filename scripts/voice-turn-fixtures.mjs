/** Deterministic time for turn-boundary regressions; no wall-clock sleeping. */
export function turnClock() {
  let now = 100000, next = 0; const jobs = new Map();
  return {
    now: () => now,
    later: (callback, ms) => { const id = ++next; jobs.set(id, { at: now + ms, callback }); return id; },
    cancel: id => jobs.delete(id),
    advance(ms) {
      const end = now + ms;
      for (let i = 0; ; i++) {
        const nextJob = [...jobs].filter(([, job]) => job.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!nextJob) break;
        if (i > 1000) throw Error('Timer did not settle');
        jobs.delete(nextJob[0]); now = nextJob[1].at; nextJob[1].callback();
      }
      now = end;
    },
    get pending() { return jobs.size; },
  };
}
