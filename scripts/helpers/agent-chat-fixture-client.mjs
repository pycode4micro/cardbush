// Test-only transport injection. Production CLI always opens its local host.
import { AgentHttpClient } from '../../dist-electron/agentHttpClient.mjs';
export const openClient = process.env.CARDBUSH_TEST_AGENT_URL
  ? async () => new AgentHttpClient(process.env.CARDBUSH_TEST_AGENT_URL, process.env.CARDBUSH_TEST_AGENT_TOKEN)
  : undefined;
