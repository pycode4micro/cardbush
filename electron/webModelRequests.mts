import { WebError } from './webCommon.mjs';

// Match the native provider's wire budget, which is separate from token limits.
export const WEB_MODEL_REQUEST_MAX_BYTES = 40_000_000;

/** Bound large JSON preparation/upload, while response streams remain concurrent. */
export class WebModelRequests {
  private busy = false;
  private waiting: { start: () => void }[] = [];

  async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.waiting.length >= 32) throw new WebError(503, '模型请求正在排队，请稍后重试。');
    if (this.busy) await new Promise<void>((resolve, reject) => {
      const cancel = () => {
        this.waiting = this.waiting.filter(item => item !== entry);
        reject(signal.reason);
      };
      const entry = { start: () => { signal.removeEventListener('abort', cancel); resolve(); } };
      signal.addEventListener('abort', cancel, { once: true });
      this.waiting.push(entry);
    });
    else this.busy = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next.start();
      else this.busy = false;
    };
  }
}
