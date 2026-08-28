import { app, net } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import netNode from 'node:net';
import os from 'node:os';
import path from 'node:path';

type HostRequest = {
  path: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
};

type LaunchSpec = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
};

export class CardbushAppService {
  private child: ChildProcess | null = null;
  private hostPort = 0;
  private readonly hostToken = randomBytes(32).toString('base64url');
  private startPromise: Promise<void> | null = null;
  private stopping = false;
  private registrationTimer: ReturnType<typeof setTimeout> | null = null;
  private registeredBackend: URL | null = null;
  private registrationGeneration = 0;

  start(): Promise<void> {
    if (this.startPromise != null) {
      return this.startPromise;
    }
    this.startPromise = this.startInternal().catch((error) => {
      this.startPromise = null;
      throw error;
    });
    return this.startPromise;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.registrationGeneration += 1;
    this.clearRegistrationTimer();
    const backend = this.registeredBackend;
    this.registeredBackend = null;
    if (backend != null) {
      await this.unregisterFromBushServer(backend).catch((error) => {
        console.warn('[cardbush_app] MCP unregister failed', error);
      });
    }
    const child = this.child;
    this.child = null;
    this.startPromise = null;
    if (child == null || child.exitCode != null) {
      return;
    }
    child.kill();
    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 8_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    if (!exited && child.pid != null) {
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
        await new Promise<void>((resolve) => killer.once('exit', () => resolve()));
      } else {
        child.kill('SIGKILL');
      }
    }
  }

  async request(input: HostRequest): Promise<unknown> {
    await this.start();
    const requestPath = String(input.path ?? '').trim();
    if (!requestPath.startsWith('/host/v1/')) {
      throw new Error('Only cardbush_app host API paths are allowed.');
    }
    const method = input.method ?? 'GET';
    const response = await net.fetch(`http://127.0.0.1:${this.hostPort}${requestPath}`, {
      method,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${this.hostToken}`,
        ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    });
    const text = await response.text();
    let payload: unknown = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`cardbush_app returned invalid JSON (${response.status})`);
    }
    if (!response.ok) {
      const record = payload != null && typeof payload === 'object'
        ? payload as Record<string, unknown>
        : {};
      const error = record.error != null && typeof record.error === 'object'
        ? record.error as Record<string, unknown>
        : {};
      throw new Error(String(error.message ?? `cardbush_app request failed (${response.status})`));
    }
    return payload;
  }

  private async startInternal(): Promise<void> {
    this.stopping = false;
    const registrationGeneration = ++this.registrationGeneration;
    this.hostPort = await allocateLoopbackPort();
    const backend = backendEndpoint();
    const dataDir = path.join(app.getPath('userData'), 'host');
    fs.mkdirSync(dataDir, { recursive: true });
    const launch = resolveLaunchSpec({
      port: this.hostPort,
      dataDir,
      backendHost: backend.hostname,
      backendPort: Number(backend.port || 51717),
      hostToken: this.hostToken,
    });
    const logDir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const log = fs.openSync(path.join(logDir, 'cardbush_app.log'), 'a');
    const child = spawn(launch.command, launch.args, {
      env: launch.env,
      cwd: app.getAppPath(),
      windowsHide: true,
      stdio: ['ignore', log, log],
    });
    fs.closeSync(log);
    this.child = child;
    child.once('exit', () => {
      if (this.child === child) {
        this.child = null;
        this.clearRegistrationTimer();
        if (!this.stopping) {
          this.startPromise = null;
        }
      }
    });
    await waitUntilReady(this.hostPort, child);
    this.scheduleRegistration(backend, 0, registrationGeneration);
  }

  private scheduleRegistration(
    backend: URL,
    delayMs: number,
    generation: number,
  ): void {
    this.clearRegistrationTimer();
    if (
      this.stopping
      || generation !== this.registrationGeneration
      || this.child == null
      || this.child.exitCode != null
    ) {
      return;
    }
    this.registrationTimer = setTimeout(() => {
      this.registrationTimer = null;
      void this.registerWithBushServer(backend)
        .then(async () => {
          if (this.stopping || generation !== this.registrationGeneration) {
            await this.unregisterFromBushServer(backend).catch(() => undefined);
            return;
          }
          this.registeredBackend = backend;
        })
        .catch((error) => {
          if (!this.stopping && generation === this.registrationGeneration) {
            console.warn('[cardbush_app] MCP registration pending', error);
            this.scheduleRegistration(backend, 2_000, generation);
          }
        });
    }, Math.max(0, delayMs));
  }

  private clearRegistrationTimer(): void {
    if (this.registrationTimer != null) {
      clearTimeout(this.registrationTimer);
      this.registrationTimer = null;
    }
  }

  private async registerWithBushServer(backend: URL): Promise<void> {
    const endpoint = new URL('/v1/mcp/servers/cardbush_app', backend);
    const response = await net.fetch(endpoint.toString(), {
      method: 'PUT',
      headers: {
        ...bushHeaders(endpoint),
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        id: 'cardbush_app',
        description: 'CardBush desktop host capabilities',
        transport: 'streamable_http',
        url: `http://127.0.0.1:${this.hostPort}/mcp`,
        headers: { Authorization: `Bearer ${this.hostToken}` },
        timeout_seconds: 60,
        exposure_default: 'on_demand',
        tool_exposure: {
          computer_use: 'on_demand',
          transport_deliver: 'contextual',
        },
        context_access: [
          'session_id',
          'turn_id',
          'tool_call_id',
          'transport_channel',
          'permission_grants',
          'filesystem_roots',
        ],
      }),
    });
    if (!response.ok) {
      throw new Error(`BushServer rejected cardbush_app MCP registration (${response.status})`);
    }
  }

  private async unregisterFromBushServer(backend: URL): Promise<void> {
    const endpoint = new URL('/v1/mcp/servers/cardbush_app', backend);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2_000);
    try {
      const response = await net.fetch(endpoint.toString(), {
        method: 'DELETE',
        headers: {
          ...bushHeaders(endpoint),
          accept: 'application/json',
        },
        signal: controller.signal,
      });
      if (!response.ok && response.status !== 404) {
        throw new Error(`BushServer rejected cardbush_app MCP unregister (${response.status})`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}

function resolveLaunchSpec(input: {
  port: number;
  dataDir: string;
  backendHost: string;
  backendPort: number;
  hostToken: string;
}): LaunchSpec {
  const sourceRoot = path.join(app.getAppPath(), 'cardbush_app', 'src');
  const explicit = process.env.CARDBUSH_APP_EXECUTABLE?.trim();
  const packaged = path.join(process.resourcesPath, 'cardbush_app', 'cardbush_app.exe');
  const localPython = process.platform === 'win32'
    ? path.join(app.getAppPath(), 'cardbush_app', '.venv', 'Scripts', 'python.exe')
    : path.join(app.getAppPath(), 'cardbush_app', '.venv', 'bin', 'python');
  const commonArgs = [
    'serve',
    '--host', '127.0.0.1',
    '--port', String(input.port),
    '--data-dir', input.dataDir,
    '--bushserver-host', input.backendHost,
    '--bushserver-port', String(input.backendPort),
  ];
  const env = {
    ...process.env,
    CARDBUSH_APP_HOST_TOKEN: input.hostToken,
    PYTHONUTF8: '1',
    PYTHONUNBUFFERED: '1',
  };
  if (explicit) {
    return { command: explicit, args: commonArgs, env };
  }
  if (app.isPackaged && fs.existsSync(packaged)) {
    return { command: packaged, args: commonArgs, env };
  }
  const python = fs.existsSync(localPython)
    ? localPython
    : (process.platform === 'win32' ? 'python' : 'python3');
  return {
    command: python,
    args: ['-m', 'cardbush_app', ...commonArgs],
    env: {
      ...env,
      PYTHONPATH: [sourceRoot, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
    },
  };
}

function backendEndpoint(): URL {
  const configured = process.env.CARDBUSH_BACKEND_BASE_URL?.trim()
    || process.env.VITE_BACKEND_BASE_URL?.trim()
    || 'http://127.0.0.1:51717';
  const parsed = new URL(configured);
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
    throw new Error('CardBush desktop requires a loopback BushServer endpoint.');
  }
  return parsed;
}

function bushHeaders(target: URL): Record<string, string> {
  const headers: Record<string, string> = {};
  const token = process.env.BUSH_API_AUTH_TOKEN?.trim();
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  const secret = readLocalRequestSecret();
  if (secret && ['127.0.0.1', 'localhost', '::1'].includes(target.hostname)) {
    headers['X-Bush-Local-Key'] = secret;
  }
  return headers;
}

function readLocalRequestSecret(): string {
  const direct = process.env.BUSH_LOCAL_REQUEST_SECRET?.trim();
  if (direct) {
    return direct;
  }
  const override = process.env.BUSH_LOCAL_REQUEST_SECRET_PATH?.trim();
  const candidate = override || (process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || process.env.APPDATA || os.homedir(), 'bushserver', 'config', 'local_request_secret')
    : path.join(os.homedir(), '.local', 'share', 'bushserver', 'config', 'local_request_secret'));
  try {
    return fs.readFileSync(candidate, 'utf8').trim();
  } catch {
    return '';
  }
}

async function allocateLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = netNode.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address != null ? address.port : 0;
      server.close((error) => error == null ? resolve(port) : reject(error));
    });
  });
}

async function waitUntilReady(port: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(`cardbush_app exited during startup (${child.exitCode})`);
    }
    try {
      const response = await net.fetch(`http://127.0.0.1:${port}/readyz`);
      if (response.ok) {
        return;
      }
    } catch {
      // The port is not accepting requests yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  child.kill();
  throw new Error('cardbush_app startup timed out');
}

export type { HostRequest };
