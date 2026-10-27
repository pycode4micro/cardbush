import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export const chromeConnectorProtocol = 'cardbush.chrome_connector.v1' as const;
const maximumBridgeResponseCharacters = 64 * 1024 * 1024;
const extensionStages = new Set([
  'broker_forwarded', 'extension_received', 'scope_ready', 'checking_access',
  'attaching_debugger', 'debugger_ready', 'command_pending', 'command_finished',
]);

export type ChromeConnectorDiagnostics = {
  requestId: string;
  method: string;
  command?: string;
  tabId?: number;
  elapsedMs: number;
  stage: string;
  stages: Array<{ stage: string; elapsedMs: number }>;
  reconnectAttempts?: number;
};

type BridgeConfig = {
  protocol: typeof chromeConnectorProtocol;
  endpoint: string;
  token: string;
};

export class ChromeConnectorError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ChromeConnectorError';
    this.code = code;
    this.details = details;
  }
}

type RequestOptions = {
  configPath?: string;
  healthPath?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  onDiagnostics?: (diagnostics: ChromeConnectorDiagnostics) => void;
};

export async function requestChromeConnector(method: string, params: Record<string, unknown> = {}, options: RequestOptions = {}): Promise<unknown> {
  const startedAt = Date.now(), totalMs = options.timeoutMs ?? 30_000;
  const reconnectDeadline = startedAt + Math.min(8000, totalMs / 2);
  let attempts = 0, timing: ChromeConnectorDiagnostics | undefined;
  let expectedConnectionId: string | undefined;
  try {
    while (true) {
      options.signal?.throwIfAborted();
      const offset = Date.now() - startedAt;
      try {
        return await requestChromeConnectorOnce(method, params, { ...options, expectedConnectionId, timeoutMs: Math.max(1, totalMs - offset),
          onDiagnostics: value => { timing = { ...value, elapsedMs: Date.now() - startedAt,
            stages: [...(attempts ? [{ stage: 'waiting_for_browser', elapsedMs: 0 }] : []),
              ...value.stages.map(stage => ({ ...stage, elapsedMs: stage.elapsedMs + offset }))],
            ...(attempts ? { reconnectAttempts: attempts } : {}) }; },
        });
      } catch (error) {
        // Only the broker's explicit pre-dispatch offline response may be retried.
        // Never replay timeouts, disconnects or a command already sent to a browser.
        if (!(error instanceof ChromeConnectorError) || error.code !== 'browser_unavailable'
          || error.details.retryable !== true || error.details.execution !== 'not_dispatched'
          || typeof error.details.connectionId !== 'string'
          || Date.now() + 250 >= reconnectDeadline) throw error;
        expectedConnectionId ??= error.details.connectionId;
        attempts++;
        await delay(250, undefined, { signal: options.signal });
      }
    }
  } catch (error) {
    error = withConnectorHealth(error, options);
    if (error instanceof ChromeConnectorError && timing) throw new ChromeConnectorError(error.code, error.message, { ...error.details, diagnostics: timing });
    throw error;
  } finally {
    if (timing) { try { options.onDiagnostics?.(timing); } catch { /* Diagnostic subscribers do not affect delivery. */ } }
  }
}

/** Startup diagnostics belong to this Runtime instance, not an old shared
 * descriptor or an arbitrary log. Consult them only after a failed connection;
 * a working broker always wins, and an uncertain dispatched action stays so. */
function withConnectorHealth(error: unknown, options: RequestOptions): unknown {
  if (!(error instanceof ChromeConnectorError) || !['bridge_config_missing', 'bridge_config_unavailable',
    'bridge_config_invalid', 'cardbush_bridge_unavailable'].includes(error.code)
    || error.details.execution === 'unknown') return error;
  const file = options.healthPath ?? process.env.CARDBUSH_CHROME_CONNECTOR_HEALTH;
  const config = options.configPath ?? process.env.CARDBUSH_CHROME_CONNECTOR_CONFIG;
  if (!file || !config) return error;
  try {
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 16_384) return error;
    const health = JSON.parse(fs.readFileSync(file, 'utf8'));
    const age = Date.now() - Date.parse(health.updatedAt);
    if (health.protocol !== 'cardbush.browser_connector_health.v1' || typeof health.configPath !== 'string'
      || path.resolve(health.configPath) !== path.resolve(config) || !Number.isFinite(age) || age < -5000 || age > 30_000) return error;
    const failure = health.state === 'disabled' ? { code: 'browser_connector_disabled', message: 'Browser Use is disabled on this host.',
      nextStep: 'Enable the Browser Use plugin in /settings, then retry /browser status.' } : health.state === 'unavailable' ? health.error : undefined;
    if (!failure || !['browser_connector_disabled', 'browser_connector_legacy_active', 'browser_connector_component_missing',
      'browser_connector_access_denied', 'browser_connector_config_invalid', 'browser_connector_start_failed'].includes(failure.code)
      || typeof failure.message !== 'string' || failure.message.length > 1500 || typeof failure.nextStep !== 'string' || failure.nextStep.length > 1000) return error;
    return new ChromeConnectorError(failure.code, failure.message, { ...error.details, execution: 'not_dispatched',
      transportReason: error.code, connector: { state: health.state, checkedAt: health.updatedAt,
        code: failure.code, message: failure.message, nextStep: failure.nextStep } });
  } catch { return error; }
}

async function requestChromeConnectorOnce(
  method: string,
  params: Record<string, unknown> = {},
  options: {
    expectedConnectionId?: string;
    configPath?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    onDiagnostics?: (diagnostics: ChromeConnectorDiagnostics) => void;
  } = {},
): Promise<unknown> {
  const config = readBridgeConfig(options.configPath);
  const requestId = randomUUID();
  const clientId = `mcp-${process.pid}-${randomUUID()}`;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const startedAt = Date.now();
  const stages = [{ stage: 'connecting', elapsedMs: 0 }];
  const mark = (stage: string) => {
    if (!stages.some(item => item.stage === stage)) stages.push({ stage, elapsedMs: Date.now() - startedAt });
  };
  const diagnostics = (): ChromeConnectorDiagnostics => ({
    requestId, method,
    ...(typeof params.command === 'string' ? { command: params.command } : {}),
    ...(typeof params.tabId === 'number' ? { tabId: params.tabId } : {}),
    elapsedMs: Date.now() - startedAt, stage: stages.at(-1)!.stage,
    stages: stages.map(item => ({ ...item })),
  });
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(config.endpoint);
    socket.setEncoding('utf8');
    socket.setNoDelay(true);
    let buffer = '';
    let settled = false;
    let requestSent = false;
    const finish = (error?: unknown, result?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      socket.destroy();
      const timing = diagnostics();
      // Diagnostics contain no URLs, command arguments, credentials or image bytes.
      try { options.onDiagnostics?.(timing); } catch { /* Observability must not change the outcome. */ }
      if (error instanceof ChromeConnectorError) reject(new ChromeConnectorError(
        error.code, error.message, { ...error.details, diagnostics: timing },
      ));
      else if (error) reject(error);
      else resolve(result);
    };
    const onAbort = () => finish(options.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(() => finish(new ChromeConnectorError(
      'browser_connector_timeout',
      `Browser Use connector did not respond to ${method} within ${timeoutMs}ms.`,
    )), timeoutMs);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    socket.on('connect', () => {
      mark('handshaking');
      socket.write(`${JSON.stringify({
        type: 'hello',
        protocol: chromeConnectorProtocol,
        role: 'mcp',
        token: config.token,
        clientId,
      })}\n`);
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > maximumBridgeResponseCharacters) {
        finish(new ChromeConnectorError(
          'bridge_response_too_large',
          'Browser Use connector returned a response larger than the supported limit.',
        ));
        return;
      }
      while (true) {
        const boundary = buffer.indexOf('\n');
        if (boundary < 0) break;
        const line = buffer.slice(0, boundary).trim();
        buffer = buffer.slice(boundary + 1);
        if (!line) continue;
        let message: Record<string, unknown>;
        try {
          message = record(JSON.parse(line));
        } catch {
          finish(new ChromeConnectorError('bridge_protocol_error', 'CardBush bridge returned invalid JSON.'));
          return;
        }
        if (message.type === 'hello_ack' && !requestSent) {
          requestSent = true;
          mark('awaiting_extension');
          socket.write(`${JSON.stringify({ type: 'request', id: requestId, method, params, expectedConnectionId: options.expectedConnectionId })}\n`);
          continue;
        }
        if (message.type === 'progress' && message.id === requestId && extensionStages.has(string(message.stage))) {
          mark(string(message.stage));
          continue;
        }
        if (message.type !== 'response' || message.id !== requestId) continue;
        const error = record(message.error);
        if (Object.keys(error).length > 0) {
          finish(new ChromeConnectorError(
            string(error.code) || 'browser_connector_failed',
            string(error.message) || `Browser Use connector failed to execute ${method}.`,
            record(error.details),
          ));
        } else {
          mark('response_received');
          finish(undefined, message.result);
        }
        return;
      }
    });
    socket.on('error', (error) => finish(new ChromeConnectorError(
      'cardbush_bridge_unavailable',
      `CardBush Browser Use bridge is unavailable: ${error.message}`,
      { execution: requestSent ? 'unknown' : 'not_dispatched' },
    )));
    socket.on('close', () => {
      if (!settled) finish(new ChromeConnectorError(
        'cardbush_bridge_closed',
        'CardBush Browser Use bridge closed before returning a response.',
      ));
    });
  });
}

function readBridgeConfig(explicitPath?: string): BridgeConfig {
  const configPath = explicitPath?.trim() ||
    process.env.CARDBUSH_CHROME_CONNECTOR_CONFIG?.trim() || '';
  if (!configPath) {
    throw new ChromeConnectorError(
      'bridge_config_missing',
      'CardBush Browser Use is not configured for this Runtime.',
    );
  }
  let candidate: Record<string, unknown>;
  try {
    candidate = record(JSON.parse(fs.readFileSync(configPath, 'utf8')));
  } catch (error) {
    throw new ChromeConnectorError(
      'bridge_config_unavailable',
      `Unable to read the CardBush Browser Use configuration: ${errorMessage(error)}`,
    );
  }
  if (
    candidate.protocol !== chromeConnectorProtocol ||
    !string(candidate.endpoint) ||
    !string(candidate.token)
  ) {
    throw new ChromeConnectorError(
      'bridge_config_invalid',
      'The CardBush Browser Use configuration is invalid.',
    );
  }
  return {
    protocol: chromeConnectorProtocol,
    endpoint: string(candidate.endpoint),
    token: string(candidate.token),
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function string(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
