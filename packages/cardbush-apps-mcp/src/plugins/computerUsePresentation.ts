import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { computerUsePresentationNative } from './computerUsePresentationNative.js';

type Notice = { kind: string; scope?: string; reason?: string; id?: number; error?: string; paused?: boolean };
type Target = { hwnd: number; elements: Array<{ index: number; focused: boolean; bounds?: { x: number; y: number; width: number; height: number } }> };
type Pending = { resolve: (value: Notice) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

/** Plugin-private presentation and take-over state, never a Runtime event projection. */
export class ComputerUsePresentation {
  #child?: ChildProcessWithoutNullStreams;
  #starting?: Promise<void>;
  #pending = new Map<number, Pending>();
  #sequence = 0;
  #owner = '';
  #stopped = new Set<string>();
  #paused = new Set<string>();
  #controller?: AbortController;
  #idleTimer?: ReturnType<typeof setTimeout>;

  assertAvailable(scope: string): void {
    if (this.#stopped.has(scope)) throw new Error('Desktop control was stopped for this turn. Do not retry; return to the user.');
    if (this.#owner && this.#owner !== scope) throw new Error('Another Computer Use session owns the window. Wait for it to finish.');
  }

  async observe(scope: string, hwnd: number): Promise<void> {
    this.assertAvailable(scope);
    const previous = this.#owner;
    this.#owner = scope;
    try {
      const result = await this.#send({ op: 'observe', scope, hwnd });
      this.assertAvailable(scope);
      if (result.paused) this.#paused.add(scope); else this.#paused.delete(scope);
    } catch (error) { if (this.#owner === scope) this.#owner = previous; throw error; }
  }

  isPaused(scope: string): boolean { return this.#paused.has(scope) && !this.#stopped.has(scope); }

  async action(scope: string, input: Record<string, unknown>, target: Target, signal?: AbortSignal) {
    this.assertAvailable(scope);
    if (this.#paused.has(scope)) throw new Error('User has taken over. Wait and observe the target again before continuing.');
    const element = target.elements.find((item) => item.index === input.element_index) ??
      target.elements.find((item) => item.focused);
    const bounds = element?.bounds;
    const x = typeof input.x === 'number' ? input.x : bounds ? Math.round(bounds.x + bounds.width / 2) : undefined;
    const y = typeof input.y === 'number' ? input.y : bounds ? Math.round(bounds.y + bounds.height / 2) : undefined;
    const controller = new AbortController();
    this.#controller = controller;
    try {
      await this.#send({ op: 'action', scope, hwnd: target.hwnd, action: input.action, x, y });
      this.assertAvailable(scope);
      if (controller.signal.aborted) throw controller.signal.reason;
      return {
        signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
        release: async () => {
          if (this.#controller === controller) this.#controller = undefined;
          if (this.#child) await this.#send({ op: 'idle', scope });
        },
      };
    } catch (error) {
      if (this.#controller === controller) this.#controller = undefined;
      throw error;
    }
  }

  async suspend(): Promise<void> { if (this.#child) await this.#send({ op: 'suspend' }); }
  async restore(): Promise<void> { if (this.#child) await this.#send({ op: 'restore' }); }
  async pause(scope: string): Promise<void> {
    this.#paused.add(scope);
    if (this.#child) await this.#send({ op: 'pause', scope });
  }
  async finish(scope: string): Promise<void> {
    if (this.#owner !== scope) return;
    this.#controller?.abort(new Error('Computer Use control session finished.'));
    // Completion must not clear an explicit user stop in the same turn.
    if (this.#child) await this.#send({ op: 'finish', scope });
    this.#owner = '';
    this.#paused.delete(scope);
    this.#controller = undefined;
  }

  dispose(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#child?.stdin.end();
  }

  async #start(): Promise<void> {
    if (this.#starting) return this.#starting;
    if (this.#child) return;
    const script = "$ErrorActionPreference='Stop'; Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:CARDBUSH_PRESENTATION_SOURCE))) -ReferencedAssemblies System.Windows.Forms,System.Drawing,System.Web.Extensions; [CardBushPresentation]::Run()";
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      windowsHide: true,
      stdio: 'pipe',
      env: { ...process.env, CARDBUSH_PRESENTATION_SOURCE: Buffer.from(computerUsePresentationNative, 'utf8').toString('base64') },
    });
    this.#child = child;
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-3000); });
    child.stdin.on('error', () => undefined);
    this.#starting = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { reject(new Error('Computer Use presentation did not start.')); child.kill(); }, 15_000);
      const lines = createInterface({ input: child.stdout });
      lines.on('line', (line) => {
        try {
          const notice = JSON.parse(line) as Notice;
          if (notice.kind === 'ready') { clearTimeout(timeout); resolve(); return; }
          this.#notice(notice);
        } catch { /* Only the private, structured protocol is consumed. */ }
      });
      child.once('error', (error) => { clearTimeout(timeout); reject(error); });
      child.once('exit', () => {
        clearTimeout(timeout);
        const error = new Error(`Computer Use presentation closed${stderr ? `: ${stderr}` : '.'}`);
        reject(error);
        if (this.#child === child) {
          this.#child = undefined;
          if (this.#owner) this.#notice({ kind: 'stopped', scope: this.#owner, reason: 'presentation_closed' });
        }
        for (const item of this.#pending.values()) { clearTimeout(item.timer); item.reject(error); }
        this.#pending.clear();
        lines.close();
      });
    }).finally(() => { this.#starting = undefined; });
    return this.#starting;
  }

  #notice(notice: Notice): void {
    if (notice.kind === 'ack' && typeof notice.id === 'number') {
      const pending = this.#pending.get(notice.id);
      if (!pending) return;
      clearTimeout(pending.timer); this.#pending.delete(notice.id);
      if (notice.error) pending.reject(new Error(notice.error)); else pending.resolve(notice);
      return;
    }
    if (!notice.scope || notice.scope !== this.#owner) return;
    if (notice.kind === 'paused' || notice.kind === 'stopped') {
      this.#paused.add(notice.scope);
      if (notice.kind === 'stopped') { this.#stopped.add(notice.scope); this.#owner = ''; }
      const error = new Error(notice.kind === 'paused' ? 'Computer Use yielded to user input. Observe again before resuming.' : 'Computer Use stopped by the user or its presentation lifetime limit.');
      this.#controller?.abort(error);
    }
  }

  async #send(command: Record<string, unknown>): Promise<Notice> {
    await this.#start();
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => {
      this.#child?.stdin.end();
      this.#idleTimer = undefined;
    }, 125_000);
    this.#idleTimer.unref();
    const id = ++this.#sequence;
    return new Promise<Notice>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        this.#child?.kill();
        reject(new Error('Computer Use presentation acknowledgement timed out.'));
      }, 4000);
      this.#pending.set(id, { resolve, reject, timer });
      this.#child!.stdin.write(JSON.stringify({ ...command, id }) + '\n');
    });
  }
}

export const computerUsePresentation = new ComputerUsePresentation();
