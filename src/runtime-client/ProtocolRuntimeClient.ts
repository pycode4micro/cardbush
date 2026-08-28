import {
  GET_RUNTIME_CAPABILITIES_COMMAND,
  decodeRuntimeCapabilities,
  decodeRuntimeEvent,
  decodeRuntimeFixture,
  type RuntimeCapabilities,
  type RuntimeEvent,
  type RuntimeFixture,
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
