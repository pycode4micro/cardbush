/** Volatile display facts only. A short invocation may finish between two UI polls. */
export class LiveToolPresentation {
  private running = new Map<string, string>();
  private recent?: { name: string; until: number };
  start(id: string, name: string) { this.running.set(id, name); }
  finish(id: string, now = Date.now()) {
    const name = this.running.get(id);
    if (name) this.recent = { name, until: now + 2200 };
    this.running.delete(id);
  }
  cancel(id: string) { this.running.delete(id); }
  current(now = Date.now()) {
    const active = this.running.values().next().value;
    if (active) return { name: active, running: true };
    if (this.recent && this.recent.until > now) return { name: this.recent.name, running: false };
  }
  clear() { this.running.clear(); this.recent = undefined; }
}
