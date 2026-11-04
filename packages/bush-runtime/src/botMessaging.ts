import { botSendInputSchema, botSendTool, unavailableBotContext, type BotContext, type BotSendInput, type BotFileAccess } from '@cardbush/bush-protocol';
import { lstat } from 'node:fs/promises';
import type { ToolRegistry } from './toolRegistry.js';
import { authorizePath, resolveToolPath } from './workspaceAccessPolicy.js';

export interface BotMessagingBridge {
  context(sessionId: string, sourceRef?: string, signal?: AbortSignal): Promise<BotContext>;
  send(sessionId: string, input: BotSendInput, signal?: AbortSignal, files?: BotFileAccess[]): Promise<unknown>;
}
export function registerBotMessagingTool(registry: ToolRegistry, bridge: BotMessagingBridge | undefined, rootSession: (id: string) => string) {
  const admitted = new WeakMap<BotSendInput, BotFileAccess[]>();
  registry.register<BotSendInput>({
    definition: botSendTool, directInvocation: true,
    manifest: { effect_kind: 'mutation', operation: 'message.send', risk: 'medium', owner: 'runtime', dispatch_scope: 'session', mutating: true },
    decodeInput: value => botSendInputSchema.parse(value),
    authorize: async context => {
      if (!bridge || context.input.action === 'status') return { kind: 'allow' };
      const state = await bridge.context(rootSession(context.sessionId), context.input.source_ref, context.signal);
      if (!state.source?.available || context.input.files.length && !state.source.capabilities.files) return { kind: 'allow' };
      const requests = [];
      const files: BotFileAccess[] = [];
      for (const path of context.input.files) {
        const canonical = await resolveToolPath(context, path), info = await lstat(canonical, { bigint: true });
        if (!info.isFile() || info.nlink !== 1n) throw Object.assign(Error('Expected a regular file.'), { code: 'regular_file_required' });
        files.push({ path: canonical, identity: `${info.dev}:${info.ino}` });
        const admission = await authorizePath('read')({ ...context, input: { path: canonical } });
        if (admission.kind === 'ask') requests.push(admission.request);
      }
      admitted.set(context.input, files);
      return requests.length ? { kind: 'ask', request: { ...requests[0]!,
        targets: requests.flatMap(r => r.targets), capabilityIds: requests.flatMap(r => r.capabilityIds) } } : { kind: 'allow' };
    },
    execute: async context => {
      if (!bridge) return { status: 'unavailable', ...unavailableBotContext() };
      const sessionId = rootSession(context.sessionId);
      if (context.input.action === 'status') return context.input.request_id
        ? bridge.send(sessionId, context.input, context.signal) : bridge.context(sessionId, context.input.source_ref, context.signal);
      const state = await bridge.context(sessionId, context.input.source_ref, context.signal);
      if (!state.source?.available) return { status: 'unavailable', code: state.source?.reason ?? state.reason ?? 'source_unavailable' };
      if (context.input.files.length && !state.source.capabilities.files) return { status: 'unavailable', code: 'bot_files_unsupported' };
      if (context.input.text && !state.source.capabilities.text) return { status: 'unavailable', code: 'bot_text_unsupported' };
      const files = admitted.get(context.input);
      if (!files || files.length !== context.input.files.length) throw Object.assign(Error('File admission is unavailable; retry the tool.'), { code: 'workspace_authorization_changed' });
      for (const [index, file] of files.entries()) if (await resolveToolPath(context, context.input.files[index]!) !== file.path)
        throw Object.assign(Error('File path changed after admission.'), { code: 'workspace_authorization_changed' });
      return bridge.send(sessionId, { ...context.input, files: files.map(file => file.path) }, context.signal, files);
    },
  });
}
