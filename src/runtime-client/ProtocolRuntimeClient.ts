import {
  ASSEMBLE_RUNTIME_SESSION_CONTEXT_COMMAND,
  GET_RUNTIME_CAPABILITIES_COMMAND,
  GET_RUNTIME_SESSION_COMMAND,
  RUN_RUNTIME_SESSION_TURN_COMMAND,
  assembleRuntimeSessionContextRequestSchema,
  decodeContextSnapshot,
  decodeRuntimeCapabilities,
  decodeRuntimeEvent,
  decodeRuntimeFixture,
  runtimeSessionIdentitySchema,
  runtimeSessionTurnRequestSchema,
  sessionSnapshotSchema,
  type ContextSnapshot,
  type RuntimeCapabilities,
  type RuntimeEvent,
  type RuntimeFixture,
  type RuntimeSessionTurnRequest,
  type SessionSnapshot,
} from '@cardbush/bush-protocol';
import {
  FixtureRuntimeTransport,
  type RuntimeFixtureScenario,
  type RuntimeFixtureTransportOptions,
} from './FixtureRuntimeTransport';
import {
  RuntimeClient,
  type RuntimeTransport,
} from './RuntimeClient';

export class ProtocolRuntimeClient extends RuntimeClient<RuntimeEvent> {
  constructor(transport: RuntimeTransport) {
    super({ transport, decodeEvent: decodeRuntimeEvent });
  }

  getCapabilities(signal?: AbortSignal): Promise<RuntimeCapabilities> {
    return this.command(
      { kind: GET_RUNTIME_CAPABILITIES_COMMAND, payload: {} },
      decodeRuntimeCapabilities,
      signal,
    );
  }

  getSession(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<SessionSnapshot | null> {
    const payload = runtimeSessionIdentitySchema.parse({ sessionId });
    return this.command(
      { kind: GET_RUNTIME_SESSION_COMMAND, payload },
      (input) => input == null ? null : sessionSnapshotSchema.parse(input),
      signal,
    );
  }

  assembleSessionContext(
    input: unknown,
    signal?: AbortSignal,
  ): Promise<ContextSnapshot> {
    const payload = assembleRuntimeSessionContextRequestSchema.parse(input);
    return this.command(
      { kind: ASSEMBLE_RUNTIME_SESSION_CONTEXT_COMMAND, payload },
      decodeContextSnapshot,
      signal,
    );
  }

  runSessionTurn(
    input: RuntimeSessionTurnRequest,
    signal?: AbortSignal,
  ): Promise<RuntimeEvent> {
    const payload = runtimeSessionTurnRequestSchema.parse(input);
    return this.command(
      { kind: RUN_RUNTIME_SESSION_TURN_COMMAND, payload },
      decodeRuntimeEvent,
      signal,
    );
  }
}

export interface RuntimeFixtureClient {
  client: ProtocolRuntimeClient;
  fixture: RuntimeFixture;
}

export function createRuntimeFixtureClient(
  input: unknown,
  options?: RuntimeFixtureTransportOptions,
): RuntimeFixtureClient {
  const fixture = decodeRuntimeFixture(input);
  const transport = new FixtureRuntimeTransport(
    fixture satisfies RuntimeFixtureScenario,
    options,
  );
  return {
    client: new ProtocolRuntimeClient(transport),
    fixture,
  };
}
