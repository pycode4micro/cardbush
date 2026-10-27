import type { AgentHttpClient } from './agentHttpClient.mjs';
import type { NativeChatTerminal } from './agentChatTerminal.mjs';
import { terminalText } from './agentChatPresentation.mjs';

const usage = 'Browser Use: /browser status | /browser retry | /browser pair chrome [name] | /browser pair edge [name] | /browser default ID | /browser revoke ID\n';

/** User-only setup: pairing credentials go to this terminal, never to a model
 * message, tool result or saved conversation. Browser selection stays in tools. */
export async function chatBrowserCommand(text: string, client: Pick<AgentHttpClient, 'call'>,
  io: Pick<NativeChatTerminal, 'commitInput' | 'status'>, signal: AbortSignal): Promise<boolean> {
  const match = /^\s*\/browser(?:\s+(.*))?\s*$/s.exec(text);
  if (!match) return false;
  io.commitInput(text);
  const args = match[1]?.trim() ?? '';
  if (/[\r\n\0]/.test(args)) { io.status(usage); return true; }
  const pairing = /^pair\s+(chrome|edge)(?:\s+(.+))?$/.exec(args);
  const manage = /^(default|revoke)\s+([a-f0-9]{32})$/.exec(args);
  if (args && args !== 'status' && args !== 'retry' && !pairing && !manage) { io.status(usage); return true; }
  try {
    signal.throwIfAborted();
    const input = pairing ? { action: 'pair', browser: pairing[1], ...(pairing[2] ? { label: pairing[2] } : {}) }
      : manage ? { action: manage[1] === 'default' ? 'select-default' : 'revoke', id: manage[2] } : { action: args === 'retry' ? 'retry' : 'status' };
    const result = await client.call('browser.connector', input, AbortSignal.any([signal, AbortSignal.timeout(15_000)])) as {
      code?: string; expiresAt?: string; browser?: string; extensionPath?: string; state?: string; error?: string; shared?: boolean; nextStep?: string;
      connector?: { defaultConnectionId: string; connections: Array<{ id: string; browser: string; label: string; connected: boolean }>;
        connectionAttempt?: { at: string; stage: string; reason?: string; connectionId?: string } };
    };
    if (pairing) {
      if (!result.code || !result.expiresAt) throw new Error('The Agent did not return a pairing code.');
      io.status(`\n${terminalText(result.browser ?? pairing[1])} pairing code (expires ${terminalText(result.expiresAt)}):\n${terminalText(result.code)}\n`);
      io.status('Manual connection / remote Agent pairing: paste this code directly into the CardBush Browser Use extension in that browser, never into the model conversation. Keep this CLI open while pairing.\n');
    } else {
      io.status(`Browser connector: ${terminalText(result.state ?? 'unavailable')}${result.error ? ` — ${terminalText(result.error)}` : ''}\n`);
      if (result.state === 'unavailable') {
        io.status(`${terminalText(result.nextStep ?? 'Check the current CLI /logs for the host startup error, then retry /browser status.')}\n`);
        return true;
      }
      if (result.state === 'disabled') {
        io.status('Enable the Browser Use plugin in /settings, then retry /browser status.\n');
        return true;
      }
      const connections = result.connector?.connections ?? [];
      const attempt = result.connector?.connectionAttempt;
      if (attempt && !connections.some(connection => connection.connected)) io.status(`Latest browser handshake: ${terminalText(attempt.stage)}${attempt.reason ? ` (${terminalText(attempt.reason)})` : ''} at ${terminalText(attempt.at)}${attempt.connectionId ? `; connection ${terminalText(attempt.connectionId)}` : ''}\n`);
      for (const connection of connections) io.status(`${connection.id === result.connector?.defaultConnectionId ? '*' : ' '} ${terminalText(connection.id)}  ${terminalText(connection.browser)}  ${terminalText(connection.label)}  ${connection.connected ? 'online' : 'offline'}\n`);
      if (!connections.length) io.status(result.shared
        ? 'Waiting for Browser Use. Install or reload the Chrome/Edge extension, then approve the first local connection in the CardBush extension window; no pairing code is needed. For manual connection only: /browser pair chrome or /browser pair edge.\n'
        : 'No paired browsers on this Agent server. For manual connection or remote Agent pairing, use /browser pair chrome or /browser pair edge.\n');
      else if (connections.some(connection => !connection.connected)) io.status('Open the original browser profile. The extension retries up to three times, then waits for you to click Connect. If the saved connection keeps failing and you want this local App/CLI, choose “重新申请本机连接” in the extension and confirm once in its CardBush window. A temporary disconnect does not require a new pairing code.\n');
      io.status(usage);
    }
    if (result.extensionPath) io.status(`Extension folder: ${terminalText(result.extensionPath)}\nLoad it in chrome://extensions or edge://extensions if needed.\n`);
    io.status('After connecting, ask the Agent to list_browsers and select_browser using the returned connectionId. '
      + (result.shared
        ? 'The local App and CLI share this connection and reconnect automatically after disconnects or restarts. Chrome/Edge work without the desktop App; integrated CardBush tabs require the App.\n'
        : 'This Agent server keeps separate connections from the local App/CLI. Saved pairings reconnect automatically.\n'));
  } catch (error) {
    signal.throwIfAborted();
    io.status(`[Browser setup unavailable] ${terminalText(error instanceof Error ? error.message : String(error))}\n`);
  }
  return true;
}
