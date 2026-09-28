export interface RuntimeStreamCursor {
  afterSequence?: number;
  lastEventId?: string;
}

export interface RuntimeStreamRequest {
  sessionId: string;
  turnId?: string;
  cursor?: RuntimeStreamCursor;
  signal?: AbortSignal;
  onTransportState?: (update: { state: 'retrying' | 'recovered'; attempt: number; nextRetryMs?: number; message?: string }) => void;
}

export interface RuntimeCommand<TPayload = unknown> {
  kind: string;
  payload: TPayload;
}

/**
 * Transport owns delivery only. Runtime lifecycle, retry, ordering, permissions,
 * persistence and terminal-state decisions remain on the Runtime side.
 */
export interface RuntimeTransport {
  openEventStream(request: RuntimeStreamRequest): AsyncIterable<unknown>;
  sendCommand(command: RuntimeCommand, signal?: AbortSignal): Promise<unknown>;
}

export type RuntimeDecoder<TValue> = (input: unknown) => TValue;

export interface RuntimeClientOptions<TEvent> {
  transport: RuntimeTransport;
  decodeEvent: RuntimeDecoder<TEvent>;
}

export class RuntimeClient<TEvent> {
  readonly #transport: RuntimeTransport;
  readonly #decodeEvent: RuntimeDecoder<TEvent>;

  constructor(options: RuntimeClientOptions<TEvent>) {
    this.#transport = options.transport;
    this.#decodeEvent = options.decodeEvent;
  }

  async *events(request: RuntimeStreamRequest): AsyncIterable<TEvent> {
    // A fresh subscription has no event ID. UI checkpoints may represent that
    // as an empty string, while the wire protocol accepts only nonempty IDs.
    const lastEventId = request.cursor?.lastEventId?.trim();
    const cursor = request.cursor ? {
      ...(request.cursor.afterSequence != null ? { afterSequence: request.cursor.afterSequence } : {}),
      ...(lastEventId ? { lastEventId } : {}),
    } : undefined;
    for await (const rawEvent of this.#transport.openEventStream({ ...request, cursor })) {
      if (request.signal?.aborted) {
        return;
      }
      yield this.#decodeEvent(rawEvent);
    }
  }

  async command<TResponse>(
    command: RuntimeCommand,
    decodeResponse: RuntimeDecoder<TResponse>,
    signal?: AbortSignal,
  ): Promise<TResponse> {
    const response = await this.#transport.sendCommand(command, signal);
    return decodeResponse(response);
  }
}
