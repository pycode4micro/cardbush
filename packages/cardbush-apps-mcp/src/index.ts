#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { pathToFileURL } from 'node:url';

import { registerComputerUsePlugin } from './plugins/computerUse.js';
import {
  readAppsRuntimeConfig,
  type CardbushAppsRuntimeConfig,
} from './config.js';

export function createCardbushAppsServer(
  config: CardbushAppsRuntimeConfig = readAppsRuntimeConfig(),
): McpServer {
  const server = new McpServer({
    name: 'cardbush_apps',
    version: '0.1.0',
  }, {
    instructions: [
      'CardBush Apps is an independent MCP extension host.',
      'Each installed app registers its tools with this server; CardBush only consumes the MCP catalog.',
    ].join(' '),
  });
  if (config.computerUse.installed && config.computerUse.enabled) {
    registerComputerUsePlugin(server, config.computerUse.config);
  }
  return server;
}

export {
  defaultAppsRuntimeConfig,
  readAppsRuntimeConfig,
} from './config.js';
export type {
  CardbushAppsRuntimeConfig,
  ComputerUsePluginConfig,
} from './config.js';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void serveStdio(() => createCardbushAppsServer());
  console.error('cardbush_apps MCP server running on stdio');
}
