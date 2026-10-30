export interface DictationSegment { segment: number; final: boolean }
export interface DictationUpdate { id: string; final: boolean }
interface Recognition { text: string; speaker?: string; speakerVerified?: boolean }

/** One recognition at a time. Replace queued snapshots instead of building a backlog. */
export class DictationPreview {
  private queue: Array<DictationSegment & { blob: Blob }> = [];
  private running = false;
  private closed = false;
  private request?: string;
  private committed: string[] = [];
  constructor(private recognize: (blob: Blob, id: string) => Promise<Recognition>,
    private emit: (text: string) => void, private cancel: (id: string) => void,
    private requireVerification = false) {}

  append(blob: Blob, segment: DictationSegment) {
    if (this.closed) return;
    const pending = this.queue.findIndex(item => item.segment === segment.segment);
    if (pending >= 0) this.queue[pending] = { blob, ...segment };
    else this.queue.push({ blob, ...segment });
    // Slow/unavailable engines retain the complete recording for Stop. Never
    // queue unlimited inference or discard the user's full recording.
    if (this.queue.length > 3) { this.close(); return; }
    void this.drain();
  }
  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (!this.closed && this.queue.length) {
        const next = this.queue.shift()!;
        const id = crypto.randomUUID(); this.request = id;
        const result = await this.recognize(next.blob, id);
        if (this.closed) return;
        this.request = undefined;
        const text = result.speaker || this.requireVerification && !result.speakerVerified ? '' : result.text.trim();
        if (text) this.emit([...this.committed, text].join(' '));
        if (next.final && text) this.committed.push(text);
      }
    } catch {
      // Preview is opportunistic; Stop still performs the normal authoritative
      // recognition, including its existing error/retry UI and identity check.
      this.close();
    } finally { this.running = false; }
  }
  close() {
    this.closed = true; this.queue = [];
    if (this.request) this.cancel(this.request);
    this.request = undefined;
  }
}
