import assert from 'node:assert/strict';
import { resolve } from 'node:path';

import { BUSH_MCP_SNAPSHOT_PROTOCOL } from '@cardbush/bush-protocol';
import { ToolRegistry } from '@cardbush/bush-runtime';
import { McpClientManager } from '@cardbush/bush-mcp-client';

const entry = resolve(
  'assets',
  'plugins',
  'chrome',
  'runtime',
  'chrome-devtools-mcp',
  'build',
  'src',
  'bin',
  'chrome-devtools-mcp.js',
);
const env = Object.fromEntries(
  Object.entries(process.env).filter((entry) => typeof entry[1] === 'string'),
);
const registry = new ToolRegistry();
const manager = new McpClientManager({ registry });

try {
  const applied = await Promise.race([
    manager.apply({
      protocol: BUSH_MCP_SNAPSHOT_PROTOCOL,
      snapshotId: 'chrome-official-bundle-test',
      revision: 1,
      servers: [{
        id: 'chrome_devtools',
        transport: {
          kind: 'stdio',
          command: process.execPath,
          args: [entry, '--no-usage-statistics', '--no-performance-crux'],
          env: {
            ...env,
            CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1',
            CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1',
          },
        },
        versionMode: 'auto',
        defaultToolPolicy: {
          permission: 'ask',
          parallelSafe: false,
          visibleToChild: true,
        },
        toolPolicies: {},
      }],
    }),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error('Official Chrome DevTools MCP startup timed out.')),
      20_000,
    )),
  ]);
  const server = applied.servers.find((candidate) => candidate.id === 'chrome_devtools');
  assert.ok(server);
  assert.ok(server.tools.length >= 20, `Expected the full Chrome tool catalog, received ${server.tools.length}`);
  assert.ok(server.tools.some((tool) => tool.remoteName === 'navigate_page'));
  assert.ok(registry.resolve('mcp__chrome_devtools__navigate_page'));
  console.log(`official Chrome DevTools MCP bundle loaded ${server.tools.length} tools`);
} finally {
  await manager.close();
}
