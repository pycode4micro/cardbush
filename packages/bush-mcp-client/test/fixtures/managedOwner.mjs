import { McpClientManager } from '../../dist/index.js';
import { ToolRegistry } from '@cardbush/bush-runtime';
const manager = new McpClientManager({ registry: new ToolRegistry() });
await manager.apply(JSON.parse(process.env.FIXTURE_SNAPSHOT));
process.send('ready');
setInterval(() => {}, 1000);
