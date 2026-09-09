import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { OpenAiProbeError, OpenAiProbeProtocolError, startOpenAiProbeLogin } from './lib/openai-hosted-probe.mjs';

const { values } = parseArgs({ options: { 'app-id': { type: 'string' }, 'tool-resource': { type: 'string' }, 'interactive': { type: 'boolean', default: false } } });
const safeMessages = new Set([
  'OpenAI login was declined or failed.',
  'OpenAI login timed out. Start a new login.',
  'OpenAI authorization expired or was rejected. Sign in again.',
  'OpenAI returned an invalid JSON response.',
  'OpenAI login cancelled.',
  'OpenAI returned an empty response.',
  'OpenAI response exceeds the size limit.',
  'OpenAI returned an unsupported token response.',
  'OAuth callback ports are occupied. Existing applications were left running.',
  'The selected application/profile tool is not available for this OpenAI login.',
  'This probe only permits read-only tools with no required arguments.',
]);
function reportFailure(error) {
  const safeProtocolError = error instanceof OpenAiProbeProtocolError || error?.name === 'OpenAiProbeProtocolError';
  const safeHttpError = error instanceof OpenAiProbeError || error?.name === 'OpenAiProbeError';
  console.error(JSON.stringify({ stage: 'probe_failed', errorType: error?.constructor?.name ?? 'Error',
    ...(safeHttpError || safeProtocolError ? error.diagnostics : {}),
    message: safeHttpError || safeProtocolError || safeMessages.has(error?.message)
      ? error.message : 'Independent connection failed. No credentials or remote response content were logged.' }));
}
let login, input, holdingTimer, expiresAt;
try {
  login = await startOpenAiProbeLogin();
  console.log(JSON.stringify({ stage: 'awaiting_openai_login', authorizationUrl: login.authorizationUrl, credentials: 'memory_only', usesCodexProcess: false }));
  const tokens = await login.result;
  await login.close();
  console.log(JSON.stringify({ stage: 'openai_login_succeeded' }));
  const run = async () => {
    // Reload only this fixed local module so a bounded diagnostic session can be retried without another login.
    const { probeOpenAiHostedTools } = await import(`./lib/openai-hosted-probe.mjs?probe=${Date.now()}`);
    try {
      const facts = await probeOpenAiHostedTools(tokens, { appId: values['app-id'], resourceName: values['tool-resource'],
        onProgress: facts => console.log(JSON.stringify(facts)) });
      console.log(JSON.stringify({ stage: 'probe_completed', ...facts })); process.exitCode = 0;
    } catch (error) { reportFailure(error); process.exitCode = 1; }
  };
  if (values.interactive) {
    input = createInterface({ input: process.stdin, crlfDelay: Infinity });
    expiresAt = Date.now() + 15 * 60_000;
    holdingTimer = setTimeout(() => input.close(), 15 * 60_000);
  }
  await run();
  if (input) {
    console.log(JSON.stringify({ stage: 'session_held_in_memory', expiresAt: new Date(expiresAt).toISOString(), commands: ['retry', 'stop'] }));
    for await (const line of input) {
      if (line.trim() === 'stop') break;
      if (line.trim() === 'retry') await run();
    }
  }
} catch (error) {
  reportFailure(error);
  process.exitCode = 1;
} finally { clearTimeout(holdingTimer); input?.close(); await login?.close(); }
