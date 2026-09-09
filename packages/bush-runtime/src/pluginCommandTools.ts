import { dirname } from 'node:path';
import type { ModelRequest } from '@cardbush/bush-protocol';
import { CLAUDE_TOOL_NAMES, type PluginCommand } from './pluginExtensions.js';
import { bashExecutable, executePluginProcess } from './pluginHookRunner.js';
import type { ToolRegistry, ToolAdmissionDecision } from './toolRegistry.js';

interface CommandInput { command: string; arguments: string; prepared?: CommandPlan }
interface CommandPlan { command: PluginCommand; arguments: string; tokens: string[]; cwd: string; pieces: Array<{ text?: string; script?: string; admissionScript?: string }> }

export function parsePluginCommandInvocation(text: string) {
  const match = text.trimStart().match(/^\/([A-Za-z0-9_.-]+:[A-Za-z0-9_-]+)(?:\s+([\s\S]*))?$/);
  return match ? { command: match[1]!, arguments: match[2] ?? '' } : undefined;
}

/** Commands retain their own identity and invocation lifecycle; no Skill files are generated. */
export function registerPluginCommandTools(registry: ToolRegistry, load: () => Promise<PluginCommand[]>) {
  registry.register({
    definition: { name: 'list_plugin_commands', description: 'List installed plugin Commands and their argument hints. Invoke a model-callable command with run_plugin_command; user-only commands require the user to send the shown slash command.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    manifest: { effect_kind: 'observation', operation: 'plugins.commands.list', risk: 'low', owner: 'runtime', dispatch_scope: 'parent_session', mutating: false },
    decodeInput: () => ({}), parallelSafe: true,
    execute: async () => (await load()).map(command => ({ id: command.id, description: command.description, argumentHint: command.argumentHint, userInvocable: command.userInvocable, modelInvocable: !command.disableModelInvocation })),
  });
  registry.register<CommandInput>({
    definition: { name: 'run_plugin_command', description: 'Invoke an installed plugin Command by its exact plugin:command id and argument string. The host expands its parameters and executes declared dynamic context after permission checks. Follow the returned command instructions in this turn.',
      inputSchema: { type: 'object', properties: { command: { type: 'string' }, arguments: { type: 'string', default: '' } }, required: ['command'], additionalProperties: false } },
    manifest: { effect_kind: 'filesystem_change', operation: 'plugins.commands.invoke', risk: 'medium', owner: 'runtime', dispatch_scope: 'parent_session', mutating: true },
    executionChannel: 'runtime:default', parallelSafe: false,
    decodeInput: value => {
      const input = value as Record<string, unknown>;
      if (!input || typeof input.command !== 'string' || (input.arguments !== undefined && typeof input.arguments !== 'string')) throw new Error('Command id and arguments must be strings.');
      return { command: input.command, arguments: String(input.arguments ?? '') };
    },
    authorize: async context => {
      const command = (await load()).find(item => item.id === context.input.command);
      if (!command) return deny('plugin_command_unavailable', '命令不存在或所属插件已停用。');
      const userInvoked = context.turn?.request.metadata.pluginCommandUserCallId === context.toolCall.id && context.turn.request.metadata.pluginCommandUserId === command.id;
      if (userInvoked ? !command.userInvocable : command.disableModelInvocation) return deny('plugin_command_invocation_disabled', userInvoked ? '此命令不允许通过用户输入直接调用。' : '此命令只能由用户通过 /命令名 调用。');
      const plan = await prepareCommand(command, context.input.arguments, context.turn?.request);
      context.input.prepared = plan;
      const asks: Array<Extract<ToolAdmissionDecision, { kind: 'ask' }>['request']> = [];
      for (const piece of plan.pieces) {
        if (piece.script === undefined) continue;
        if (deniesShell(command.disallowedTools) || deniesShell(context.turn?.request.metadata.pluginCommandDisallowedTools)) return deny('plugin_command_tool_disallowed', 'Command disallowed-tools prevents dynamic shell context.');
        const terminal = registry.resolve('terminal_exec');
        if (!terminal?.authorize || !context.turn?.request.tools.some(tool => tool.name === 'terminal_exec')) return deny('plugin_command_shell_unavailable', 'Dynamic command context requires the exposed terminal_exec tool.');
        const admission = await terminal.authorize({ ...context,
          toolCall: { ...context.toolCall, name: 'terminal_exec', argumentsText: JSON.stringify({ command: piece.admissionScript, cwd: plan.cwd }) },
          input: { command: piece.admissionScript, cwd: plan.cwd, yieldTimeMs: 1000, shell: command.shell === 'bash' ? 'posix' : 'powershell' },
          actionManifest: { ...context.actionManifest, ...terminal.manifest } });
        if (admission.kind === 'deny') return admission;
        if (admission.kind === 'ask') asks.push(admission.request);
      }
      return asks.length ? { kind: 'ask', request: {
        reason: `Command /${command.id} needs dynamic context:\n${asks.map(value => value.reason).join('\n')}`,
        actions: [...new Set(asks.flatMap(value => value.actions))], targets: asks.flatMap(value => value.targets), capabilityIds: [...new Set(asks.flatMap(value => value.capabilityIds))],
      } } : { kind: 'allow' };
    },
    execute: async context => {
      const plan = context.input.prepared;
      if (!plan) throw new Error('Command preparation is missing.');
      const command = plan.command;
      if (context.turn) context.turn.request.metadata.pluginCommandDisallowedTools = [...new Set([
        ...stringArray(context.turn.request.metadata.pluginCommandDisallowedTools), ...command.disallowedTools ?? [],
      ])];
      const contextResults: Array<{ command: string; stdout: string; stderr: string; exitCode: number }> = [];
      let prompt = '';
      for (const piece of plan.pieces) {
        if (context.signal?.aborted) throw context.signal.reason ?? new DOMException('Command cancelled.', 'AbortError');
        if (piece.script === undefined) { prompt += substitute(piece.text ?? '', plan); continue; }
        const result = await executePluginProcess({ command: piece.script, shell: command.shell, timeout: 30 }, '', plan.cwd, { ...process.env }, context.signal);
        contextResults.push({ command: piece.script, ...result });
        if (result.exitCode !== 0) throw Object.assign(new Error(`Command /${command.id} context failed (${result.exitCode}): ${result.stderr || result.stdout}`), { code: 'plugin_command_context_failed', details: { contextResults } });
        prompt += result.stdout.slice(0, 24000);
      }
      if (!/\$(?:ARGUMENTS\b|\d+\b)/.test(command.prompt) && !command.arguments.some(name => command.prompt.includes(`$${name}`)) && plan.arguments.trim()) prompt += `\n\nArguments: ${plan.arguments}`;
      return { command: command.id, source: command.path, arguments: plan.arguments, contextResults,
        instructions: `Run command /${command.id} in the current task. Command resources: ${dirname(command.path)}. Plugin root: ${command.root}.\nUse CardBush tools and the current model. Host permission rules apply.\n${command.allowedTools?.length ? `Declared tool preapprovals: ${command.allowedTools.join(', ')}. These do not override CardBush permissions.\n` : ''}${prompt}` };
    },
    renderModelResult: value => (value as { instructions?: string }).instructions,
  });
}

function deny(code: string, message: string): ToolAdmissionDecision { return { kind: 'deny', code, message }; }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []; }
function deniesShell(value: unknown) { return stringArray(value).some(name => ['Bash', 'PowerShell', 'terminal_exec'].includes(name)); }
export function pluginCommandDeniesTool(request: ModelRequest | undefined, name: string) {
  return stringArray(request?.metadata.pluginCommandDisallowedTools).some(rule => (CLAUDE_TOOL_NAMES[rule] ?? [rule]).includes(name));
}
export function commandArguments(text: string): string[] {
  const tokens: string[] = []; let token = '', quote = '', started = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '\\' && quote === '"' && ['"', '\\'].includes(text[i + 1] ?? '')) { token += text[++i]; started = true; }
    else if (quote) { if (ch === quote) quote = ''; else token += ch; started = true; }
    else if (ch === '"' || ch === "'") { quote = ch; started = true; }
    else if (/\s/.test(ch)) { if (started) tokens.push(token); token = ''; started = false; }
    else { token += ch; started = true; }
  }
  if (quote) throw new Error('命令参数的引号未闭合。');
  if (started) tokens.push(token);
  return tokens;
}
function values(plan: CommandPlan): Record<string, string> {
  return { ARGUMENTS: plan.arguments, CLAUDE_PLUGIN_ROOT: plan.command.root, CODEX_PLUGIN_ROOT: plan.command.root, CARDBUSH_PLUGIN_ROOT: plan.command.root,
    CLAUDE_PROJECT_DIR: plan.cwd, ...Object.fromEntries(plan.command.arguments.map((name, index) => [name, plan.tokens[index] ?? ''])) };
}
function substitute(text: string, plan: CommandPlan) {
  const variables = values(plan);
  return text.replace(/\$ARGUMENTS\[(\d+)\]|\$(\d+)\b|\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g,
    (match, indexed, numeric, braced, named) => indexed !== undefined || numeric !== undefined ? plan.tokens[Number(indexed ?? numeric)] ?? '' : variables[braced ?? named] ?? match);
}
const bashQuote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const powershellQuote = (text: string) => `'${text.replaceAll("'", "''")}'`;
async function prepareCommand(command: PluginCommand, args: string, request?: ModelRequest): Promise<CommandPlan> {
  if (args.length > 64000 || command.prompt.length > 256000) throw new Error('Command input is too large.');
  const plan: CommandPlan = { command, arguments: args, tokens: commandArguments(args), cwd: String(request?.metadata.workspaceDir || request?.metadata.projectDir || process.cwd()), pieces: [] };
  const matches = [...command.prompt.matchAll(/```![ \t]*\r?\n([\s\S]*?)\r?\n```|!`([^`\r\n]+)`/g)];
  if (matches.length > 20) throw new Error('Command exceeds 20 dynamic context steps.');
  let offset = 0;
  for (const match of matches) {
    plan.pieces.push({ text: command.prompt.slice(offset, match.index) });
    const raw = match[1] ?? match[2]!;
    let script: string;
    if (command.shell === 'powershell') {
      script = `${Object.entries(values(plan)).map(([name, value]) => `$${name} = ${powershellQuote(value)}\n$env:${name} = ${powershellQuote(value)}`).join('\n')}\n$cardbushCommandArgs = @(${plan.tokens.map(powershellQuote).join(',')})\n` +
        raw.replace(/\$ARGUMENTS\[(\d+)\]|\$(\d+)\b/g, (_, a, b) => `$cardbushCommandArgs[${a ?? b}]`);
    } else {
      script = `${Object.entries(values(plan)).map(([name, value]) => `export ${name}=${bashQuote(value)}`).join('\n')}\nset -- ${plan.tokens.map(bashQuote).join(' ')}\n` +
        raw.replace(/\$ARGUMENTS\[(\d+)\]|\$(\d+)\b/g, (_, a, b) => `\${${Number(a ?? b) + 1}}`);
    }
    if (command.shell === 'bash') await bashExecutable();
    // Admission inspects the original script with its real shell grammar, never an opaque launcher.
    plan.pieces.push({ script, admissionScript: script }); offset = match.index! + match[0].length;
  }
  plan.pieces.push({ text: command.prompt.slice(offset) });
  return plan;
}
