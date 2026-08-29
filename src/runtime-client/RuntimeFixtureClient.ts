import {
  decodeRuntimeFixture,
  type RuntimeFixture,
} from '@cardbush/bush-protocol/runtime-fixture';

import {
  FixtureRuntimeTransport,
  type RuntimeFixtureScenario,
  type RuntimeFixtureTransportOptions,
} from './FixtureRuntimeTransport';
import { ProtocolRuntimeClient } from './ProtocolRuntimeClient';

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
