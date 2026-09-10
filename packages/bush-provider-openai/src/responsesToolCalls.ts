import type { ModelEvent } from '@cardbush/bush-protocol';
import { clientToolSearchArguments, isClientToolSearchCall, type ResponsesToolSearchMode } from './responsesReplay.js';
import { ResponseOutputIndex } from './responsesOutputIndex.js';

type Delta = Omit<Extract<ModelEvent, { kind: 'tool_call_delta' }>, 'protocol' | 'requestId' | 'sequence' | 'createdAt'>;
type Call = {
  type: 'function_call' | 'tool_search_call';
  id?: string; itemId?: string; name?: string;
  arguments: string; argumentsDone: boolean;
  emittedIdentity: boolean; emittedChars: number;
};

export class ResponseToolCallError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/** Reconcile lifecycle events and final snapshots before the Runtime may execute a batch. */
export class ResponseToolCalls {
  readonly #calls = new Map<number, Call>();
  readonly #callIndices = new Map<string, number>();
  constructor(readonly outputIndex: ResponseOutputIndex) {}

  get hasCalls(): boolean { return this.#calls.size > 0; }

  #changed(): never {
    throw new ResponseToolCallError('provider_tool_call_changed', 'The provider changed a tool call identity or its arguments.');
  }

  #call(index: number, type: Call['type']): Call {
    if (!Number.isSafeInteger(index) || index < 0) this.#changed();
    let call = this.#calls.get(index);
    if (call && call.type !== type) this.#changed();
    if (!call) {
      call = { type, arguments: '', argumentsDone: false, emittedIdentity: false, emittedChars: 0 };
      this.#calls.set(index, call);
    }
    return call;
  }

  #identity(call: Call, index: number, field: 'id' | 'itemId' | 'name', value: unknown): void {
    if (value === undefined || value === null || value === '') return;
    if (typeof value !== 'string' || (call[field] && call[field] !== value)) this.#changed();
    const indices = field === 'id' ? this.#callIndices : undefined;
    const previous = indices?.get(value);
    if (previous !== undefined && previous !== index) this.#changed();
    indices?.set(value, index);
    call[field] = value;
  }

  #completeArguments(call: Call, text: unknown): void {
    if (typeof text !== 'string' || !text.startsWith(call.arguments) || (call.argumentsDone && text !== call.arguments)) this.#changed();
    call.arguments = text;
    call.argumentsDone = true;
  }

  #emit(call: Call, index: number, aliases: Map<string, string> | undefined, append: (event: Delta) => void): void {
    if (!call.id || !call.name || (call.type === 'tool_search_call' && !call.argumentsDone)) return;
    const nameDelta = call.emittedIdentity ? undefined : aliases?.get(call.name) ?? call.name;
    const argumentsDelta = call.arguments.slice(call.emittedChars) || undefined;
    if (nameDelta || argumentsDelta) append({ kind: 'tool_call_delta', index, toolCallId: call.id, nameDelta, argumentsDelta });
    call.emittedIdentity = true;
    call.emittedChars = call.arguments.length;
  }

  item(item: { type: string; [key: string]: unknown }, index: number, completed: boolean,
    mode: ResponsesToolSearchMode | undefined, aliases: Map<string, string> | undefined, append: (event: Delta) => void): void {
    this.outputIndex.observe(index, item.id, item.type);
    if (item.type !== 'function_call' && item.type !== 'tool_search_call') {
      if (this.#calls.has(index)) this.#changed();
      return;
    }
    if (item.type === 'tool_search_call' && (mode !== 'native' || item.execution !== 'client' || (completed && !isClientToolSearchCall(item)))) {
      throw new ResponseToolCallError('provider_tool_search_invalid', 'The provider returned an invalid or unrequested client tool search call.');
    }
    const call = this.#call(index, item.type);
    this.#identity(call, index, 'id', item.call_id);
    this.#identity(call, index, 'itemId', item.id);
    this.#identity(call, index, 'name', item.type === 'tool_search_call' ? 'mcp_search' : item.name);
    if (completed) {
      if (!call.id || !call.name || (item.status !== undefined && item.status !== 'completed')) {
        throw new ResponseToolCallError('provider_tool_call_incomplete', 'The provider did not complete a tool call.');
      }
      this.#completeArguments(call, item.type === 'tool_search_call' ? clientToolSearchArguments({ arguments: item.arguments }) : item.arguments);
    }
    this.#emit(call, index, aliases, append);
  }

  arguments(event: { type: string; output_index: number; item_id?: string; name?: string; delta?: string; arguments?: string },
    aliases: Map<string, string> | undefined, append: (event: Delta) => void): void {
    const call = this.#call(event.output_index, 'function_call');
    this.outputIndex.observe(event.output_index, event.item_id, 'function_call');
    this.#identity(call, event.output_index, 'itemId', event.item_id);
    this.#identity(call, event.output_index, 'name', event.name);
    if (event.type === 'response.function_call_arguments.done') this.#completeArguments(call, event.arguments);
    else {
      if (typeof event.delta !== 'string' || (call.argumentsDone && event.delta)) this.#changed();
      call.arguments += event.delta;
    }
    this.#emit(call, event.output_index, aliases, append);
  }

  snapshotIndices(items: { type: string; [key: string]: unknown }[]): number[] {
    const seen = new Set<number>();
    return items.map((item, position) => {
      // A compatible endpoint may omit other items in its terminal snapshot.
      // Known immutable IDs retain their original output_index in that case.
      const index = this.outputIndex.index(item.id)
        ?? (typeof item.call_id === 'string' ? this.#callIndices.get(item.call_id) : undefined) ?? position;
      if (item.type === 'function_call' || item.type === 'tool_search_call') {
        if (seen.has(index)) this.#changed();
        seen.add(index);
      }
      return index;
    });
  }

  finish(): void {
    for (const call of this.#calls.values()) {
      if (!call.id || !call.name || !call.argumentsDone) {
        throw new ResponseToolCallError('provider_tool_call_incomplete', 'The provider ended the response with an unfinished tool call.');
      }
    }
  }
}
