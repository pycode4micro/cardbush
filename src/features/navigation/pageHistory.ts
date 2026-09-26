export type PageSnapshot<Route> = { route: Route; views: Record<string, unknown> };
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/** Window-local visits only. Stream updates, form edits and network results are not routes. */
export class PageHistory<Route> {
  private entries: PageSnapshot<Route>[];
  private index = 0;
  private route: Route;
  private views: Record<string, unknown> = {};
  private pendingRoute?: Route;
  private queued = false;
  private listeners = new Set<() => void>();
  private revision = 0;
  constructor(route: Route, private restore: (route: Route) => void, private available: (route: Route) => boolean = () => true) {
    this.route = route;
    this.entries = [{ route, views: {} }];
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getRevision = () => this.revision;
  private publish() { this.revision++; this.listeners.forEach(listener => listener()); }
  configure(restore: (route: Route) => void, available: (route: Route) => boolean) { this.restore = restore; this.available = available; }
  observe(route: Route) {
    if (this.pendingRoute !== undefined) {
      if (!equal(route, this.pendingRoute)) return;
      this.pendingRoute = undefined;
    }
    if (equal(this.route, route)) return;
    this.route = route;
    this.schedule();
  }
  read<T>(key: string, fallback: T): T { return Object.hasOwn(this.views, key) ? this.views[key] as T : fallback; }
  update<T>(key: string, fallback: T, update: T | ((prior: T) => T)) {
    const prior = this.read(key, fallback);
    const value = typeof update === 'function' ? (update as (prior: T) => T)(prior) : update;
    if (equal(prior, value)) return;
    // Save the initial value so Back can restore a view first visited on this entry.
    if (!Object.hasOwn(this.views, key)) this.entries[this.index].views = { ...this.entries[this.index].views, [key]: fallback };
    this.views = { ...this.views, [key]: value };
    this.publish();
    this.schedule();
  }
  private schedule() {
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => this.flush());
  }
  flush() {
    this.queued = false;
    if (this.pendingRoute !== undefined) return;
    const next = { route: this.route, views: this.views };
    if (equal(this.entries[this.index], next)) return;
    this.entries = [...this.entries.slice(0, this.index + 1), next].slice(-80);
    this.index = this.entries.length - 1;
    this.publish();
  }
  private target(delta: number) {
    for (let index = this.index + delta; index >= 0 && index < this.entries.length; index += delta) {
      if (this.available(this.entries[index].route)) return index;
    }
    return -1;
  }
  get canGoBack() { return this.target(-1) >= 0; }
  get canGoForward() { return this.target(1) >= 0; }
  back = () => this.move(-1);
  forward = () => this.move(1);
  private move(delta: number) {
    this.flush();
    const index = this.target(delta);
    if (index < 0) return;
    const next = this.entries[index];
    this.pendingRoute = equal(this.route, next.route) ? undefined : next.route;
    this.index = index; this.route = next.route; this.views = next.views;
    this.restore(next.route);
    this.publish();
  }
}
