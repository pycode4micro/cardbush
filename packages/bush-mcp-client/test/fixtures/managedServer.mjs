import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

if (process.argv[2] === 'child') {
  const service = createServer(socket => socket.end('fixture'));
  service.listen(Number(process.env.FIXTURE_PORT ?? 0), '127.0.0.1', () => {
    process.send({ pid: process.pid, port: service.address().port });
    process.disconnect();
  });
} else {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'child'], {
    env: process.env, detached: process.platform === 'win32', stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
  });
  const service = await new Promise((resolve, reject) => {
    child.once('message', resolve); child.once('error', reject);
    child.once('exit', () => reject(new Error('Child could not acquire its service port.')));
  });
  child.unref();
  const identity = { pid: process.pid, childPid: service.pid, port: service.port };
  appendFileSync(process.env.FIXTURE_RECEIPTS, JSON.stringify(identity) + '\n');
  if (process.env.FIXTURE_NO_HANDSHAKE === '1') {
    process.stdin.resume(); setInterval(() => {}, 1000);
  } else {
    const { McpServer, fromJsonSchema } = await import('@modelcontextprotocol/server');
    const { serveStdio } = await import('@modelcontextprotocol/server/stdio');
    if (process.env.FIXTURE_IGNORE_EOF === '1') setInterval(() => {}, 1000);
    await serveStdio(() => {
      const server = new McpServer({ name: 'managed-fixture', version: '1' });
      server.registerTool('echo', { inputSchema: fromJsonSchema({ type: 'object', properties: { value: { type: 'string' } } }) },
        async input => ({ content: [{ type: 'text', text: JSON.stringify({ ...identity, value: input.value }) }] }));
      server.registerTool('crash', { inputSchema: fromJsonSchema({ type: 'object' }) }, async () => process.exit(1));
      if (process.env.FIXTURE_CRASH_MS) setTimeout(() => process.exit(1), Number(process.env.FIXTURE_CRASH_MS));
      return server;
    });
  }
}
