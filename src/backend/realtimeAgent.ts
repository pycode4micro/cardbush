import { REALTIME_AGENT_TOOL_COMMAND, type RealtimeAgentToolRequest } from '@cardbush/bush-protocol';
import { REALTIME_CONTEXT_COMPACTION_COMMAND, realtimeContextResultSchema } from '@cardbush/bush-protocol';
import { REALTIME_TASK_SUMMARY_COMMAND, realtimeTaskSummaryResultSchema } from '@cardbush/bush-protocol';
import { createDesktopRuntimeSession } from '../runtime-client/ElectronRuntimeSession';
import { prepareRuntimeAgentRequest } from './runtimeChat';
import type { ChatStreamRequest } from './api';
import type { RealtimeAgentExecutor } from '../features/voice/realtimeAgentBridge';
import { emitSubagentDispatch } from '../features/subagents/subagentObservabilityEvents';
import { appendConversationEntry } from './conversationJournal';

/** Uses exactly the same model, prompt, workspace and tool preparation as text chat. */
export function createRealtimeAgentExecutor(prepare: () => Promise<ChatStreamRequest>, sessionId: () => string,
  options: { targetAgent?: () => string; assistant?: boolean; conversationGeneration?: number } = {}): RealtimeAgentExecutor {
  const pageIds = new Map<string, string>();
  let preparedVoice:ChatStreamRequest|undefined;
  const configForCall = async () => preparedVoice ??= await prepare();
  return {
    async prepareConversation() { return (await configForCall()).sessionId; },
    async record(entry) { await appendConversationEntry((await configForCall()).sessionId, entry, options.conversationGeneration); },
    async pageWrite(id, content) {
      if (!options.assistant) throw Error('page_write is only available in assistant.');
      // Vendor call IDs may repeat in the next call; retries within this call keep one journal entry.
      const entryId = pageIds.get(id) ?? `page-${crypto.randomUUID()}`;
      pageIds.set(id, entryId);
      await appendConversationEntry((await configForCall()).sessionId, { id: entryId, content, role: 'assistant', source: 'page', visibility: 'conversation', createdAt: new Date().toISOString() }, options.conversationGeneration);
    },
    async compact(job, signal) {
      const runtime=createDesktopRuntimeSession();
      try {
        if (sessionId()!==job.sessionId && preparedVoice?.sessionId!==job.sessionId) throw Error('Voice conversation changed.');
        const config=preparedVoice?.sessionId===job.sessionId ? preparedVoice : await prepare();
        if (config.sessionId!==job.sessionId) throw Error('Voice conversation changed.');
        const {runtimeRequest:parent}=await prepareRuntimeAgentRequest({...config,userInput:'Voice context maintenance'},runtime,
          {turnId:`voice_memory_${job.jobId}`,signal});
        const model={model:parent.model,providerBinding:parent.providerBinding,reasoningEffort:parent.reasoningEffort,metadata:parent.metadata};
        return await runtime.client.command({kind:REALTIME_CONTEXT_COMPACTION_COMMAND,payload:{job,model}},
          value=>realtimeContextResultSchema.parse(value),signal);
      } finally {runtime.dispose();}
    },
    async summarize(taskId, language, signal) {
      const runtime = createDesktopRuntimeSession();
      try {
        const config = await configForCall();
        const { runtimeRequest: parent } = await prepareRuntimeAgentRequest({ ...config, userInput: 'Summarize a completed voice task' }, runtime,
          { turnId: `voice_summary_${crypto.randomUUID()}`, signal });
        const model = { model: parent.model, providerBinding: parent.providerBinding, reasoningEffort: parent.reasoningEffort, metadata: parent.metadata };
        return (await runtime.client.command({ kind: REALTIME_TASK_SUMMARY_COMMAND, payload: { sessionId: config.sessionId, taskId, language, model } },
          value => realtimeTaskSummaryResultSchema.parse(value), signal)).speech;
      } finally { runtime.dispose(); }
    },
    async execute(callId, action, args) {
      const runtime = createDesktopRuntimeSession();
      try {
        const capabilities = await runtime.client.getCapabilities();
        if (!capabilities.supportedCommands.includes(REALTIME_AGENT_TOOL_COMMAND)) throw Object.assign(
          new Error('当前运行的 Runtime 尚不支持语音子代理，请重新启动更新后的 CardBush。'),
          { code: 'realtime_runtime_outdated' });
        const config = await configForCall();
        const parent = action === 'read_subagent_conversation' ? undefined :
          (await prepareRuntimeAgentRequest({ ...config as ChatStreamRequest, userInput: String(args.prompt) }, runtime,
            { turnId: `voice_turn_${crypto.randomUUID()}` })).runtimeRequest;
        // Vendor call IDs may repeat after reconnecting. This command ID stays
        // stable across transport retries; the voice bridge deduplicates vendor calls.
        const payload: RealtimeAgentToolRequest = { sessionId: config.sessionId, callId: `voice_tool_${crypto.randomUUID()}`, action, parent,
          prompt: args.prompt as string | undefined, taskId: args.task_id as string | undefined, cursor: args.cursor as string | undefined,
          targetAgent: options.targetAgent?.() || undefined };
        const result = await runtime.client.command({ kind: REALTIME_AGENT_TOOL_COMMAND, payload }, value => value as Record<string, unknown>);
        if (parent && typeof result.taskId === 'string' && result.status === 'running') emitSubagentDispatch({
          protocol: 'bush.subagent_dispatch.v1', phase: 'dispatched', status: 'running', terminal: false, accepted: true,
          taskId: result.taskId, toolCallId: callId, parentSessionId: config.sessionId, parentTurnId: parent.turnId,
          childSessionId: result.childSessionId as string, childTurnId: result.childTurnId as string, origin: 'subagent', raw: result,
        });
        return result;
      } finally { runtime.dispose(); }
    },
    async list() {
      const runtime = createDesktopRuntimeSession();
      try { const id = preparedVoice?.sessionId || sessionId(); return id ? await runtime.client.listSubagentTasks({ parentSessionId: id }) : []; }
      finally { runtime.dispose(); }
    },
  };
}
