import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { Ajv } from 'ajv';
import { bridgePluginCatalogSchema, bridgeFilePaths, bridgeToolName, type BridgePluginCatalog, type BridgeToolCall,
  type BotContext, type BotFileAccess, type ModelRequest } from '@cardbush/bush-protocol';
import type { ToolRegistry, ToolAdmissionContext, ToolRegistration } from './toolRegistry.js';
import { authorizePath, resolveToolPath } from './workspaceAccessPolicy.js';

export interface BotMessagingBridge {
  context(sessionId: string, sourceRef?: string, signal?: AbortSignal): Promise<BotContext>;
  catalog(sessionId: string, signal?: AbortSignal): Promise<BridgePluginCatalog>;
  call(sessionId: string, input: BridgeToolCall, signal?: AbortSignal, files?: BotFileAccess[]): Promise<unknown>;
}
const fail = (code: string): never => { throw Object.assign(Error(code), { code }); };
type Arguments = Record<string, unknown>;
/** Transport-neutral bridge tools share the ordinary MCP discovery/admission path. */
export class BridgePluginTools {
  constructor(private registry: ToolRegistry, private bridge: BotMessagingBridge | undefined, private rootSession: (id: string) => string) {}
  async prepare<T extends { sessionId: string; tools: ModelRequest['tools']; metadata: ModelRequest['metadata'] }>(request: T, signal?: AbortSignal): Promise<T> {
    if (request.metadata.botDeliveryLocalOnly === true) return { ...request,
      tools: request.tools.filter(tool => tool.name !== 'send_to_bot' && !tool.name.startsWith('mcp__bridge_')) };
    await this.sync(request.sessionId, signal);
    const scope = { ...request, protocol: 'bush.model_request.v1', messages: [] } as unknown as ModelRequest;
    const prior = new Set(request.tools.map(tool => tool.name));
    const additions = !request.metadata.pluginAgentId && !request.metadata.automationRunId && request.metadata.agentRole !== 'child' && request.metadata.toolExecutionPolicy !== 'none';
    const tools = this.registry.definitions().filter(tool => this.registry.resolve(tool.name)?.registrationOwner?.startsWith('bridge:') &&
      (additions || prior.has(tool.name)) && this.registry.resolve(tool.name)?.modelAvailable?.(scope) !== false);
    return { ...request, tools: [...request.tools.filter(tool => tool.name !== 'send_to_bot' && !tool.name.startsWith('mcp__bridge_')), ...tools] };
  }
  async sync(sessionId: string, signal?: AbortSignal) {
    if (!this.bridge) return;
    const root = this.rootSession(sessionId), owner = `bridge:${root}`;
    let catalog: BridgePluginCatalog;
    try { catalog = bridgePluginCatalogSchema.parse(await this.bridge.catalog(root, signal)); }
    catch { signal?.throwIfAborted(); this.registry.removeOwned(owner); return; }
    const registrations = catalog.filter(entry => entry.sessionId === root && entry.expiresAt > Date.now()).flatMap(entry => {
      try { return entry.plugin.tools.map(tool => this.registration(entry, tool.name, root)); }
      catch { return []; } // A malformed external schema must not stop an unrelated conversation.
    });
    this.registry.replaceOwned(owner, registrations);
  }
  private registration(entry: BridgePluginCatalog[number], toolName: string, root: string): ToolRegistration<Arguments> {
    const bridge = this.bridge!, tool = entry.plugin.tools.find(tool => tool.name === toolName)!;
    const name = bridgeToolName(entry.connectionId, entry.plugin.id, tool.name);
    const validate = new Ajv({ strict: false, allErrors: false }).compile(tool.inputSchema);
    const admissions = new WeakMap<Arguments, { input: BridgeToolCall; files: BotFileAccess[] }>();
    const available = (request: ModelRequest) => request.metadata.botDeliveryLocalOnly !== true && this.rootSession(request.sessionId) === root && entry.expiresAt > Date.now() &&
      !(request.metadata.disabledTools as string[] | undefined)?.includes(name);
    const resolve = async (context: ToolAdmissionContext<Arguments>) => {
      if (!context.turn || !available(context.turn.request)) return fail('bridge_tool_unavailable');
      const metadata = context.turn.request.metadata;
      const active = typeof metadata.botSourceRef === 'string' ? [metadata.botSourceRef]
        : Array.isArray(metadata.botSourceRefs) ? metadata.botSourceRefs.filter((ref): ref is string => typeof ref === 'string') : [];
      const explicit = context.input.source_ref as string | undefined;
      if (explicit && active.length && !active.includes(explicit)) return fail('bridge_source_mismatch');
      let ref = explicit ?? (active.length === 1 ? active[0] : undefined);
      if (!ref && active.length > 1) return fail('bridge_source_ambiguous');
      const singleRecipient = !active.length && metadata.botRequiresSingleRecipient === true;
      const state = await bridge.context(root, singleRecipient ? undefined : ref, context.signal);
      if (!ref || singleRecipient) {
        const sources = state.targets.filter(source => source.available && (singleRecipient || source.connectionId === entry.connectionId));
        if (sources.length !== 1) return fail('bridge_source_required');
        if (ref && ref !== sources[0]!.sourceRef) return fail('bridge_source_mismatch');
        ref = sources[0]!.sourceRef;
      }
      const source = state.source ?? state.targets.find(source => source.sourceRef === ref);
      if (!source?.available) return fail(source?.reason ?? 'bridge_disconnected');
      if (source.connectionId !== entry.connectionId) return fail('bridge_source_mismatch');
      const { source_ref: _source, request_id: id, ...args } = context.input;
      return { connectionId: entry.connectionId, pluginId: entry.plugin.id, revision: entry.revision, tool: tool.name,
        sourceRef: ref, requestId: typeof id === 'string' ? id : createHash('sha256').update(JSON.stringify([context.sessionId, context.turnId, context.toolCall.id])).digest('hex'),
        arguments: args } satisfies BridgeToolCall;
    };
    return {
      definition: { name, description: `${entry.plugin.name}: ${tool.description}\nBridge plugin ${entry.plugin.id}@${entry.plugin.version}. Uses the current user message source. Disconnected or revoked connections cannot execute. Reuse request_id after an unknown outcome.`,
        inputSchema: { ...tool.inputSchema, properties: { ...tool.inputSchema.properties,
          source_ref: { type: 'string', description: 'Usually omit. Disambiguate a host-supplied sourceRef when handling several messages; never substitute another platform or sender.' },
          request_id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$', description: 'Optional stable idempotency key. Reuse the returned requestId on retries.' },
        } } },
      modelAvailable: available, visibleToChild: true,
      manifest: { effect_kind: tool.readOnly ? 'observation' : 'mutation', operation: 'bridge.plugin.call', risk: tool.readOnly ? 'low' : 'medium',
        owner: 'runtime', dispatch_scope: 'session', mutating: !tool.readOnly },
      mcpHook: { server: `bridge_${entry.connectionId.replaceAll('-', '')}_${entry.plugin.id}`, tool: tool.name, modelVisible: true,
        readOnly: tool.readOnly, appCallable: false, call: async () => fail('bridge_tool_requires_admission') },
      decodeInput(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('tool_arguments_schema_invalid');
        const args = value as Arguments, { source_ref, request_id, ...platform } = args;
        if (source_ref !== undefined && (typeof source_ref !== 'string' || !source_ref || source_ref.length > 100)
          || request_id !== undefined && (typeof request_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(request_id))
          || !validate(platform)) return fail('tool_arguments_schema_invalid');
        bridgeFilePaths(tool, platform);
        return args;
      },
      authorize: async context => {
        const input = await resolve(context), paths = bridgeFilePaths(tool, input.arguments), files: BotFileAccess[] = [], requests = [];
        for (const path of paths) {
          const canonical = await resolveToolPath(context, path), info = await lstat(canonical, { bigint: true });
          if (!info.isFile() || info.nlink !== 1n) return fail('regular_file_required');
          files.push({ path: canonical, identity: `${info.dev}:${info.ino}` });
          const admission = await authorizePath('read')({ ...context, input: { path: canonical } });
          if (admission.kind === 'ask') requests.push(admission.request);
        }
        admissions.set(context.input, { input, files });
        return requests.length ? { kind: 'ask', request: { ...requests[0]!, targets: requests.flatMap(r => r.targets), capabilityIds: requests.flatMap(r => r.capabilityIds) } } : { kind: 'allow' };
      },
      execute: async context => {
        const admitted = admissions.get(context.input);
        if (!admitted) return fail('workspace_authorization_changed');
        if ((await resolve(context)).sourceRef !== admitted.input.sourceRef) return fail('bridge_source_mismatch');
        const paths = bridgeFilePaths(tool, admitted.input.arguments);
        for (const [index, file] of admitted.files.entries()) if (await resolveToolPath(context, paths[index]!) !== file.path) return fail('workspace_authorization_changed');
        let index = 0;
        const args = { ...admitted.input.arguments };
        for (const key of tool.fileArguments) if (args[key] !== undefined)
          args[key] = Array.isArray(args[key]) ? (args[key] as unknown[]).map(() => admitted.files[index++]!.path) : admitted.files[index++]!.path;
        return bridge.call(root, { ...admitted.input, arguments: args }, context.signal, admitted.files);
      },
    };
  }
}
