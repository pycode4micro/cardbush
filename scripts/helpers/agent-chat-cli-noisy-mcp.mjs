import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';

// A wholly offline legacy MCP peer, including the noisy modern-probe fallback
// reported by the user. Delayed diagnostics are triggered while editing input.
process.stderr.write('fixture startup diagnostic\n');
const timer = setInterval(() => {
  if (!existsSync(process.env.FIXTURE_LOG_TRIGGER)) return;
  clearInterval(timer);
  for (let index = 0; index < 100; index++) process.stderr.write(`late-fixture-log ${index}\n`);
}, 20);
const reader = createInterface({ input: process.stdin });
reader.on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const reply = result => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
  if (request.method === 'server/discover') {
    process.stderr.write('Failed to validate request: unsupported server/discover\n');
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'Unsupported method' } }) + '\n');
  } else if (request.method === 'initialize') reply({ protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'noisy-fixture', version: '1' } });
  else if (request.method === 'tools/list') reply({ tools: [] });
  else if (request.method === 'ping') reply({});
});
reader.on('close', () => { clearInterval(timer); });
