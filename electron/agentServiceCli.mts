import { parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { AgentService } from './agentService.mjs';
import { serveAgentHttp } from './agentServer.mjs';

const { values } = parseArgs({ options: {
  'data-dir': { type: 'string' }, name: { type: 'string' }, transport: { type: 'string', default: 'http' },
  host: { type: 'string', default: '127.0.0.1' }, port: { type: 'string', default: '4780' }, help: { type: 'boolean' },
  sandbox: { type: 'string' }, 'sandbox-network': { type: 'string' },
} });
if (values.help) {
  process.stdout.write('命令沙盒（可选）：--sandbox required --sandbox-network disabled\n默认 off；启用后后端不可用时拒绝执行，不降级。详见 docs/EXECUTION_SANDBOX.md。\n\n');
  process.stdout.write('CardBush Agent 服务（Node.js 22.12+）\n\nnode dist-electron/agentServiceCli.mjs --data-dir /srv/cardbush/agent-a --name Agent-A [--host 127.0.0.1] [--port 4780]\n\n每个 Agent 使用独立数据目录。本机与远程均通过 HTTP 接入。\nAPI：/api/agent/v1/info、/api/agent/v1/call、/api/agent/v1/events（SSE 或 NDJSON 流）。\n令牌保存在 DATA_DIR/access-token，也可通过 CARDBUSH_AGENT_TOKEN 指定。\n远程连接通过 HTTPS 反向代理或 SSH 隧道访问。不再提供 stdio 或 MCP Agent 入口。\n');
} else {
  if (!values['data-dir']) throw new Error('--data-dir is required; never use the desktop profile directory.');
  if (values.transport !== 'http') throw new Error('Agent 服务仅支持 HTTP。请使用 --host 和 --port 启动，再通过 HTTP 地址连接。');
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port.');
  if (values.sandbox && !['off', 'required'].includes(values.sandbox)) throw new Error('--sandbox 只支持 off 或 required。');
  if (values['sandbox-network'] && !['disabled', 'enabled'].includes(values['sandbox-network'])) throw new Error('--sandbox-network 只支持 disabled 或 enabled。');
  const service = await AgentService.open({ dataRoot: resolve(values['data-dir']), name: values.name, env: {
    ...(values.sandbox ? { CARDBUSH_EXECUTION_SANDBOX: values.sandbox } : {}),
    ...(values['sandbox-network'] ? { CARDBUSH_SANDBOX_NETWORK: values['sandbox-network'] } : {}),
  } });
  let listener: { close: () => Promise<void> };
  try {
    const tokenPath = join(service.root, 'access-token');
    let token = process.env.CARDBUSH_AGENT_TOKEN?.trim();
    if (!token) {
      token = await readFile(tokenPath, 'utf8').then(value => value.trim()).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return ''; throw error; });
      if (!token) { token = randomBytes(32).toString('hex'); await writeFile(tokenPath, token + '\n', { mode: 0o600, flag: 'wx' }); }
    }
    const http = await serveAgentHttp(service, { host: values.host, port, token }); listener = http;
    process.stderr.write(`CardBush Agent ${service.info().id} listening on http://${values.host}:${http.port}\nAPI: /api/agent/v1 (JSON / SSE / NDJSON)\nAccess token: ${process.env.CARDBUSH_AGENT_TOKEN ? 'CARDBUSH_AGENT_TOKEN' : tokenPath}\n`);
  } catch (error) { await service.close(); throw error; }
  let closing = false;
  const close = () => {
    if (closing) return; closing = true;
    void listener.close().finally(() => service.close()).then(() => { process.exitCode = 0; }, error => { process.stderr.write(String(error) + '\n'); process.exitCode = 1; });
  };
  process.once('SIGINT', close); process.once('SIGTERM', close);
}
