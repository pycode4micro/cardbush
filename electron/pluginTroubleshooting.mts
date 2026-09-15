import type { McpServerSnapshot } from '@cardbush/bush-protocol';

export type PluginTroubleshootingContext = {
  capturedAt: string;
  application: 'CardBush';
  pluginId: string;
  version: string;
  source: 'bundled' | 'user';
  manifestPath: string;
  pluginRoot: string;
  pluginEnabled: boolean;
  componentId: string;
  serviceId: string;
  pluginConfigurationRevision: number;
  mcpConfigurationRevision: number;
  boundServerId?: string;
  configuredLaunch: ReturnType<typeof troubleshootingLaunch> | null;
  configurationError?: string;
};

const sensitiveName = /token|secret|password|passwd|authorization|credential|cookie|(?:api|access|private|subscription)[_-]?key|(?:^|[_-])(?:key|auth|pwd|pass)(?:$|[_-])/i;
const environmentSecrets = () => Object.entries(process.env).filter(([name]) => sensitiveName.test(name))
  .map(([, value]) => value ?? '').filter(Boolean);

/** Only a diagnostic projection leaves the host; environment/header values stay private. */
export function troubleshootingLaunch(transport: McpServerSnapshot['transport']) {
  const env = transport.kind === 'stdio' ? transport.env : {};
  const secrets = [...Object.entries(env ?? {}).filter(([name]) => sensitiveName.test(name)).map(([, value]) => value), ...environmentSecrets()].filter(Boolean);
  const clean = (value: string) => redactTroubleshootingText(value, secrets);
  if (transport.kind !== 'stdio') return {
    transport: transport.kind, endpoint: clean(transport.url), auth: transport.auth,
    headerNames: Object.keys(transport.headers ?? {}),
  };
  let hideNext = false, inlineScript = false;
  const sanitizedArgs = (transport.args ?? []).slice(0, 80).map(argument => {
    if (inlineScript) return '[inline script omitted]';
    if (hideNext) { hideNext = false; return '[redacted]'; }
    if (/^(?:-c|-e|--eval|-command|-encodedcommand|-enc)$/i.test(argument)) inlineScript = true;
    if (/^[-/]/.test(argument) && sensitiveName.test(argument.split(/[=:]/, 1)[0])) {
      const separator = argument.search(/[=:]/);
      if (separator >= 0) return `${argument.slice(0, separator + 1)}[redacted]`;
      hideNext = true;
    }
    return clean(argument);
  });
  const args: string[] = [];
  let remaining = 6_000;
  for (const argument of sanitizedArgs) {
    if (argument.length > remaining) { args.push('[additional arguments omitted]'); break; }
    args.push(argument); remaining -= argument.length;
  }
  if ((transport.args?.length ?? 0) > 80) args.push('[additional arguments omitted]');
  return { transport: transport.kind, command: clean(transport.command), args,
    cwd: transport.cwd ? clean(transport.cwd) : undefined, environmentNames: Object.keys(env ?? {}) };
}

export function redactTroubleshootingText(value: string, secrets: string[] = environmentSecrets()) {
  let result = value;
  for (const secret of [...new Set(secrets)].sort((a, b) => b.length - a.length)) result = result.replaceAll(secret, '[redacted]');
  return result.replace(/((?:Bearer|Basic)\s+)\S+/gi, '$1[redacted]')
    .replace(/(\b[\w-]*(?:token|secret|password|passwd|authorization|credential|cookie|api[_-]?key|access[_-]?key)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}&]+)/gi, '$1[redacted]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, value => {
      try { const url = new URL(value); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.href; }
      catch { return '[invalid URL omitted]'; }
    }).slice(0, 4000);
}
