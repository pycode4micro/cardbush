import type { ModelEvent, RuntimeEvent, ToolCall } from '@cardbush/bush-protocol';
import type { InMemoryRuntimeEventLog, RuntimeEventIdentity } from './runtimeEventLog.js';

type Payload = Extract<RuntimeEvent, { kind: 'file_edit_preview' }>['payload'];
type Call = { name: string; id?: string; offset: number; pending: string; published: boolean; disabled: boolean };
const names = new Set(['write_file', 'edit_file', 'apply_patch']);
const limit = 2 * 1024 * 1024;

/** Bounded, coalesced transport for a preview only; normal authorization/write tools still own the file. */
export class FileEditPreviewProjector {
  #calls = new Map<number, Call>();
  #timer?: ReturnType<typeof setTimeout>;
  #failure?: unknown;
  constructor(private log: InMemoryRuntimeEventLog, private identity: RuntimeEventIdentity, private messageId: string) {}

  accept(event: Extract<ModelEvent, { kind: 'tool_call_delta' }>): RuntimeEvent[] {
    if (this.#failure) throw this.#failure;
    if (!this.#calls.has(event.index) && this.#calls.size >= 64) return [];
    const call = this.#calls.get(event.index) ?? { name: '', offset: 0, pending: '', published: false, disabled: false };
    this.#calls.set(event.index, call);
    if (call.disabled) return [];
    call.id = event.toolCallId || call.id;
    call.name += event.nameDelta ?? '';
    call.pending += event.argumentsDelta ?? '';
    if (call.name.length > 128 || call.offset + call.pending.length > limit ||
        call.name && ![...names].some(name => name.startsWith(call.name))) {
      const events = call.published ? [this.#emit(event.index, call, 'discarded', '')] : [];
      call.pending = ''; call.disabled = true; return events;
    }
    if (!names.has(call.name) || !call.pending) return [];
    if (!call.published || call.pending.length >= 4096) return this.flush();
    if (!this.#timer) this.#timer = setTimeout(() => {
      try { this.flush(); } catch (error) { this.#failure = error; }
    }, 50);
    this.#timer?.unref();
    return [];
  }

  flush(): RuntimeEvent[] {
    clearTimeout(this.#timer); this.#timer = undefined;
    if (this.#failure) throw this.#failure;
    const events: RuntimeEvent[] = [];
    for (const [index, call] of this.#calls) if (!call.disabled && names.has(call.name) && call.pending) {
      events.push(this.#emit(index, call, 'streaming', call.pending)); call.pending = '';
    }
    return events;
  }

  finish(accepted: readonly ToolCall[] = []): RuntimeEvent[] {
    clearTimeout(this.#timer); this.#timer = undefined;
    const events: RuntimeEvent[] = [];
    for (const [index, call] of this.#calls) if (!call.disabled && names.has(call.name)) {
      const valid = accepted.some(tool => tool.id === call.id && tool.name === call.name);
      if (call.published || valid) events.push(this.#emit(index, call, valid ? 'ready' : 'discarded', valid ? call.pending : ''));
    }
    this.#calls.clear();
    return events;
  }

  #emit(index: number, call: Call, state: Payload['state'], delta: string) {
    const event = this.log.append(this.identity, { kind: 'file_edit_preview', payload: {
      previewId: `${this.messageId}:${index}`, toolCallId: call.id, toolName: call.name as Payload['toolName'],
      offset: call.offset, delta, state,
    } });
    call.offset += delta.length; call.published = true;
    return event;
  }
}
