import fs from 'node:fs';
import net from 'node:net';
import { randomUUID } from 'node:crypto';

export const chromeConnectorProtocol = 'cardbush.chrome_connector.v1' as const;
const maximumBridgeResponseCharacters = 64 * 1024 * 1024;

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

export async function requestChromeConnector(
  method: string,
  params: Record<string, unknown> = {},
  options: {
    configPath?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<unknown> {
  const config = readBridgeConfig(options.configPath);
  const requestId = randomUUID();
  const clientId = `mcp-${process.pid}-${randomUUID()}`;
  const timeoutMs = options.timeoutMs ?? 30_000;
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
      if (error) reject(error);
      else resolve(result);
    };
    const onAbort = () => finish(options.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(() => finish(new ChromeConnectorError(
      'chrome_connector_timeout',
      `Chrome Connector did not respond to ${method} within ${timeoutMs}ms.`,
    )), timeoutMs);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    socket.on('connect', () => {
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
          'Chrome Connector returned a response larger than the supported limit.',
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
          socket.write(`${JSON.stringify({ type: 'request', id: requestId, method, params })}\n`);
          continue;
        }
        if (message.type !== 'response' || message.id !== requestId) continue;
        const error = record(message.error);
        if (Object.keys(error).length > 0) {
          finish(new ChromeConnectorError(
            string(error.code) || 'chrome_connector_failed',
            string(error.message) || `Chrome Connector failed to execute ${method}.`,
            record(error.details),
          ));
        } else {
          finish(undefined, message.result);
        }
        return;
      }
    });
    socket.on('error', (error) => finish(new ChromeConnectorError(
      'cardbush_bridge_unavailable',
      `CardBush Browser Connector bridge is unavailable: ${error.message}`,
    )));
    socket.on('close', () => {
      if (!settled) finish(new ChromeConnectorError(
        'cardbush_bridge_closed',
        'CardBush Browser Connector bridge closed before returning a response.',
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
      'CardBush Browser Connector is not configured for this Runtime.',
    );
  }
  let candidate: Record<string, unknown>;
  try {
    candidate = record(JSON.parse(fs.readFileSync(configPath, 'utf8')));
  } catch (error) {
    throw new ChromeConnectorError(
      'bridge_config_unavailable',
      `Unable to read the CardBush Browser Connector configuration: ${errorMessage(error)}`,
    );
  }
  if (
    candidate.protocol !== chromeConnectorProtocol ||
    !string(candidate.endpoint) ||
    !string(candidate.token)
  ) {
    throw new ChromeConnectorError(
      'bridge_config_invalid',
      'The CardBush Browser Connector configuration is invalid.',
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
