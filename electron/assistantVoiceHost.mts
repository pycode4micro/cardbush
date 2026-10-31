import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { assistantProfileSchema, PERSONAL_ASSISTANT_SESSION, type RuntimeSessionTurnRequest, type SubagentTask, type ConversationEntry } from '@cardbush/bush-protocol';
import { createProductAgentTurnRequest, type AgentInstructionDocument } from '@cardbush/bush-product-agent';
import { RealtimeAgentBridge, realtimeConversationRecord, type RealtimeConversationExecutor } from '@cardbush/bush-runtime/realtime-conversation';
import type { ElectronProductHostController } from './productHostController.mjs';
import type { RealtimeVoiceService } from './realtimeVoiceService.js';
import type { RealtimeVoiceEvent } from './realtimeVoiceTypes.js';
import { RealtimeVoiceHangup } from './realtimeVoiceHangup.js';
import { writePrivateJson } from './atomicJsonFile.mjs';

export const assistantHostSettingsSchema = z.object({
  profile: assistantProfileSchema.default(() => assistantProfileSchema.parse({})),
  modelId: z.string().max(200).default(''),
  permissionMode: z.enum(['task_free', 'user_free', 'all_free']).default('task_free'),
  subagentPermissionRouting: z.enum(['user', 'parent']).optional(),
  planEnabled: z.boolean().default(true),
  language: z.enum(['zh', 'en']).default('zh'), voice: z.enum(['female', 'male']).default('female'),
  disabledTools: z.array(z.string()).default([]), disabledSkills: z.array(z.string()).default([]),
}).strict();
export type AssistantHostSettings = z.infer<typeof assistantHostSettingsSchema>;
export class AssistantHostSettingsStore {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private file: string) {}
  async read(): Promise<AssistantHostSettings> {
    return readFile(this.file, 'utf8').then(text => assistantHostSettingsSchema.parse(JSON.parse(text)), (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return assistantHostSettingsSchema.parse({});
    });
  }
  save(input: unknown) {
    const next = this.tail.then(() => this.savePatch(input)); this.tail = next.catch(() => {}); return next;
  }
  private async savePatch(input: unknown) {
    const patch = z.record(z.string(), z.unknown()).parse(input);
    const previous = await this.read();
    const value = assistantHostSettingsSchema.parse({ ...previous, ...patch,
      ...(patch.profile === undefined ? {} : { profile: { ...previous.profile, ...z.record(z.string(), z.unknown()).parse(patch.profile) } }),
    });
    await writePrivateJson(this.file, value);
    return value;
  }
}

export interface AssistantVoiceRuntime {
  command(kind: string, payload: unknown): Promise<any>;
  product(): Promise<Pick<ElectronProductHostController, 'execute' | 'resolveSubagentModel'>>;
  instructions(): Promise<AgentInstructionDocument[]>;
  environment: string;
}

/** The same Runtime dispatcher, model configuration and journal as desktop assistant. */
export async function createAssistantVoiceExecutor(host: AssistantVoiceRuntime, settings: AssistantHostSettings): Promise<RealtimeConversationExecutor> {
  const sessionId = PERSONAL_ASSISTANT_SESSION, product = await host.product();
  const configuration = async (kind: string) => {
    const result = await product.execute({ protocol: 'cardbush.product_host_ipc.v1', kind }) as { ok: boolean; value?: any; error?: { message?: string } };
    if (!result.ok) throw Error(result.error?.message || 'Host configuration unavailable.');
    return result.value;
  };
  if (!await host.command('runtime.get_session', { sessionId })) await host.command('runtime.create_session', {
    sessionId, metadata: { personalAssistant: true, title: settings.profile.name },
  });
  const journal = await host.command('runtime.assistant_conversation', { action: 'read', sessionId });
  const generation = journal.generation;
  const prepare = async (): Promise<RuntimeSessionTurnRequest> => {
    const models = await configuration('models.get') as { defaultModelId: string };
    const selected = await product.resolveSubagentModel(settings.modelId || models.defaultModelId) as any;
    const catalog = await host.command('runtime.get_tool_catalog', {});
    const subagents = await configuration('subagents.get');
    const request = createProductAgentTurnRequest({
      requestId: randomUUID(), messageId: randomUUID(), sessionId, turnId: `voice_turn_${randomUUID()}`, createdAt: new Date().toISOString(),
      userText: 'Execute the task requested in the assistant voice conversation.', uiLanguage: settings.language,
      model: selected.model, providerBinding: selected.binding, maxContextTokens: selected.maxContextTokens, maxOutputTokens: selected.maxOutputTokens,
      reasoningEffort: selected.reasoningEffort, permissionMode: settings.permissionMode,
      subagentPermissionRouting: settings.subagentPermissionRouting ?? subagents.permissionRouting,
      tools: catalog.filter((tool: { name: string }) => tool.name !== 'update_goal' && (!settings.disabledTools.includes(tool.name) || tool.name === 'checkpoint_context')),
      disabledSkills: settings.disabledSkills, interactiveRequestsEnabled: true, planEnabled: settings.planEnabled,
      instructionDocuments: await host.instructions(), teamInstructions: host.environment,
    });
    request.metadata.assistantOutputMode = 'voice';
    if (subagents) {
      const fixed = subagents.model?.mode === 'fixed' ? await product.resolveSubagentModel(subagents.model.modelId) as any : undefined;
      request.metadata.childAgentPolicy = { permissionRouting: settings.subagentPermissionRouting ?? subagents.permissionRouting, childPermissionMode: subagents.childPermissionMode,
        disabledTools: subagents.disabledTools, model: fixed ? { mode: 'fixed', modelId: subagents.model.modelId, model: fixed.model,
          providerBinding: fixed.binding, reasoningEffort: fixed.reasoningEffort, maxContextTokens: fixed.maxContextTokens, maxOutputTokens: fixed.maxOutputTokens } : { mode: 'inherit' } };
    }
    return request;
  };
  let recording = Promise.resolve();
  const record = (entry: ConversationEntry) => {
    recording = recording.then(async () => { await host.command('runtime.assistant_conversation', { action: 'append', sessionId, generation, entry }); });
    return recording;
  };
  // Validate configuration before accepting an audio call; pin the same host policy
  // for its lifetime, as the desktop voice executor does.
  const prepared = await prepare();
  const parent = async () => {
    await recording;
    const latest = await host.command('runtime.assistant_conversation', { action: 'read', sessionId });
    if (latest.generation !== generation) throw Error('Assistant conversation was reset; reconnect before starting another task.');
    const request = await prepare();
    const content = realtimeConversationRecord(latest.entries, Number(request.metadata.contextWindowTokens));
    if (content) request.inputMessages.unshift({ messageId: `voice-context-${request.turnId}`, message: { role: 'user', name: 'conversation_record', visibility: 'internal', content } });
    return request;
  };
  const callScope = randomUUID();
  return {
    record,
    initialContext: () => assistantTextContext(journal.entries || []),
    pageWrite: (id, content) => record({ id: `device-page-${callScope}-${id}`.slice(0, 220), role: 'assistant', content, createdAt: new Date().toISOString(), source: 'page', visibility: 'conversation' }),
    async execute(callId, action, args) {
      return host.command('runtime.realtime_agent_tool', { sessionId, callId: `${callScope}:${callId}`, action, parent: action === 'read_subagent_conversation' ? undefined : await parent(),
        prompt: args.prompt, taskId: args.task_id, cursor: args.cursor, targetAgent: settings.profile.targetAgent || undefined });
    },
    list: () => host.command('runtime.list_subagent_tasks', { parentSessionId: sessionId }) as Promise<SubagentTask[]>,
    async summarize(taskId, language) {
      const parent = prepared;
      const result = await host.command('runtime.realtime_task_summary', { sessionId, taskId, language, model: {
        model: parent.model, providerBinding: parent.providerBinding, reasoningEffort: parent.reasoningEffort, maxOutputTokens: parent.maxOutputTokens, metadata: parent.metadata,
      } }); return result.speech;
    },
    async compact(job) {
      const parent = prepared;
      return host.command('runtime.realtime_context_compaction', { job, model: {
        model: parent.model, providerBinding: parent.providerBinding, reasoningEffort: parent.reasoningEffort, maxOutputTokens: parent.maxOutputTokens, metadata: parent.metadata,
      } });
    },
  };
}

function assistantTextContext(entries: ConversationEntry[]) {
  const pairs: { role: 'user' | 'assistant'; text: string }[][] = [];
  let question = '';
  for (const entry of entries) {
    // Voice transcripts already have their own encrypted history in RealtimeVoiceService.
    if (entry.visibility === 'internal' || entry.source === 'voice') continue;
    if (entry.role === 'user') question = entry.content.slice(0, 4000);
    else if (question && entry.content.trim()) { pairs.push([{ role: 'user', text: question }, { role: 'assistant', text: entry.content.slice(0, 4000) }]); question = ''; }
  }
  let chars = 0;
  return pairs.slice(-20).reverse().filter(pair => { chars += JSON.stringify(pair).length; return chars <= 22000; }).reverse().flat();
}

/** Audio transport has no model/tool credentials and cannot invoke Runtime commands. */
export class AssistantDeviceCall {
  readonly id = randomUUID();
  private closed = false;
  private bridge: RealtimeAgentBridge;
  private partials = new Map<string, string>();
  private hangup = new RealtimeVoiceHangup(() => { this.close(); this.emit({id:this.id,type:'closed'}); });
  private outputId?: string;
  private cancelledOutputs = new Set<string>();
  constructor(private voice: RealtimeVoiceService, private owner: string, private settings: AssistantHostSettings,
    private executor: RealtimeConversationExecutor, private emit: (event: RealtimeVoiceEvent) => void) {
    this.bridge = new RealtimeAgentBridge(() => {}, async result => {
      if (!this.closed) await voice.notify(owner, this.id, JSON.stringify({ ...result, language: settings.language }));
    });
    this.bridge.update({ sessionId: PERSONAL_ASSISTANT_SESSION, environment: 'local', assistant: settings.profile, agent: executor });
  }
  async start() {
    await this.voice.start(this.owner, { id: this.id, sessionId: PERSONAL_ASSISTANT_SESSION, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, assistant: this.settings.profile, voice: this.settings.voice, context: this.executor.initialContext?.() || [] }, event => this.event(event));
    if (this.closed) { this.voice.close(this.owner); return; }
    if (this.settings.profile.microphoneMuted) this.voice.control(this.owner, this.id, 'mute');
  }
  private event(event: RealtimeVoiceEvent) {
    if (this.closed) return;
    if (event.type === 'input-start') {
      this.cancelOutput();
      this.emit({id:this.id,type:'interrupted',responseId:this.outputId});
    }
    const stale = event.responseId && this.cancelledOutputs.has(event.responseId);
    if (stale && ['audio-start','audio','audio-end','transcript','interrupted'].includes(event.type) && !(event.type==='transcript' && event.role==='user')) return;
    if (event.type === 'audio-start') { this.outputId=event.responseId; this.hangup.audioStart(event.responseId); }
    if (event.type === 'audio') { this.outputId=event.responseId; this.hangup.audio(event.responseId); }
    if (event.type === 'audio-end') this.hangup.audioEnd(event.responseId);
    if (event.type === 'interrupted' || event.type === 'connection-state' && event.state!=='connected') this.cancelOutput();
    if (event.type === 'tools') {
      let ending=false;
      void Promise.all(event.calls.map(async call => {
        if (call.name==='hang_up' || call.name==='recall_conversation') {
          try {
            const args=JSON.parse(call.arguments);
            if (!args || typeof args!=='object' || Array.isArray(args)) throw Error('Invalid call arguments.');
            if (call.name==='recall_conversation') {
              if (Object.keys(args).some(key=>key!=='cursor')) throw Error('Invalid history cursor.');
              return {id:call.id,output:JSON.stringify(this.voice.history(this.owner,this.id,args.cursor))};
            }
            if (Object.keys(args).length) throw Error('hang_up accepts an empty object.');
            if (stale) return {id:call.id,output:JSON.stringify({status:'cancelled',message:'The user resumed speaking.'})};
            this.hangup.request(event.responseId); ending=true;
            return {id:call.id,output:JSON.stringify({status:'ending',message:'The call ends after goodbye playback. Background tasks continue.'})};
          } catch { return {id:call.id,output:JSON.stringify({status:'error',message:'Invalid call arguments or unavailable history.'})}; }
        }
        return {id:call.id,output:await this.bridge.run(call)};
      })).then(results => {
        if (!this.closed) { this.voice.results(this.owner, this.id, results); this.bridge.acknowledge(event.calls); if(ending)this.hangup.acknowledge(); }
      }).catch(() => this.close());
    } else if (event.type === 'context-compact') {
      void this.executor.compact?.(event.job).then(result => { if (!this.closed) return this.voice.compacted(this.owner, this.id, event.job.jobId, result); }).catch(() => {
        if (!this.closed) this.voice.compacted(this.owner, this.id, event.job.jobId);
      });
    } else if (event.type === 'input-discarded') {
      this.partials.delete(`user:${event.itemId}`);
    } else if (event.type === 'transcript') {
      const key = `${event.role}:${event.itemId}`, prior = this.partials.get(key) || '';
      const content = event.final ? event.text || prior : event.replace ? event.text : prior + event.text;
      if (content.length > 64000 || this.partials.size > 80) { this.close(); return; }
      if (event.final) {
        this.partials.delete(key);
        if (content.trim()) void this.executor.record?.({ id: `${this.id}:${key}`.slice(0, 220), role: event.role, content,
          createdAt: new Date().toISOString(), source: 'voice', visibility: 'internal' }).catch(() => {});
      } else this.partials.set(key, content);
    }
    if (event.type !== 'tools' && event.type !== 'context-compact') this.emit(event);
  }
  private cancelOutput() {
    this.hangup.cancel();
    if (this.outputId) this.cancelledOutputs.add(this.outputId);
    while (this.cancelledOutputs.size>80) this.cancelledOutputs.delete(this.cancelledOutputs.values().next().value!);
  }
  audio(pcm: Uint8Array) { if (!this.closed) this.voice.audio(this.owner, this.id, Uint8Array.from(pcm).buffer); }
  control(action: 'interrupt' | 'commit' | 'mute' | 'unmute') { if (!this.closed) { if(action==='interrupt')this.cancelOutput(); this.voice.control(this.owner, this.id, action); } }
  playback(speaking: boolean) { if (!this.closed) { this.hangup.playback(speaking); this.voice.playback(this.owner, this.id, speaking); } }
  close() { if (this.closed) return; this.closed = true; this.hangup.close(); this.bridge.close(); this.partials.clear(); this.voice.close(this.owner, this.id); }
}
