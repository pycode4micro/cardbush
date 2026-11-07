// One host timer for automation jobs and durable Assistant event deadlines.
export class AutomationClock {
  private deadlines = new Map<() => void, number>();
  private timer?: ReturnType<typeof setTimeout>;
  schedule(callback: () => void, delay: number) {
    this.deadlines.set(callback, Date.now() + Math.max(0, delay));
    this.arm();
  }
  cancel(callback: () => void) {
    if (this.deadlines.delete(callback)) this.arm();
  }
  private arm() {
    clearTimeout(this.timer);
    if (!this.deadlines.size) return;
    const next = Math.min(...this.deadlines.values());
    this.timer = setTimeout(() => {
      const now = Date.now();
      const due = [...this.deadlines].filter(([, at]) => at <= now);
      for (const [callback] of due) this.deadlines.delete(callback);
      this.arm();
      for (const [callback] of due) callback();
    }, Math.min(2147483647, Math.max(0, next - Date.now())));
    this.timer.unref?.();
  }
}
