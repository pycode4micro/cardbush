import { join } from 'node:path';
import { z } from 'zod';
import {
  USAGE_TOOL, usageInputSchema, usageSessionSchema, usageRecipeIdentitySchema, usageDefinitionSchema,
  type DefinitionReceipt, type ModelMessage, type ModelRequest, type UsageEvidence, type UsageInput, type UsageNode, type UsageRecipeInvocation, type UsageSession,
} from '@cardbush/bush-protocol';
import { DefinitionStore } from './definitionStore.js';
import type { ToolHandlerContext, ToolRegistry } from './toolRegistry.js';
import type { ToolExecutionSignal, ToolExecutionStore } from './toolExecutionStore.js';
import { captureUsageEvidence, reviewUsage, usageAuthoringGuide } from './usageAuthoring.js';
import { isUsageBusinessSignal } from './usageSignals.js';
import type { CoordinationStore } from './coordinationStore.js';
import type { PluginCommand, PluginExtensions, PluginExtensionLoader } from './pluginExtensions.js';
import { usagePlanView } from './usagePlan.js';
import { exportUsagePackage } from './usagePackage.js';
import { recommendUsageCapability, usageAvailableTools, usageToolHint } from './usageCapabilities.js';
import { prepareUsageRecipe, usageDefinitionHash, usageRecipeInfo } from './usageRecipes.js';

export const USAGE_CONTEXT_NAME = 'usage_guidance';
export const USAGE_CONTEXT_MAX_CHARS = 24000;
const markerSchema = z.object({ turnId: z.string(), toolCallId: z.string() });
const signalSchema = markerSchema.extend({ tool: z.string(), outcome: z.enum(['returned', 'failed', 'cancelled']), errorCode: z.string().optional(), usageRecipe: usageRecipeIdentitySchema.optional() });
const recallSchema = z.object({ id: z.string(), activation: markerSchema, cursor: markerSchema, signals: z.array(signalSchema) });
type Recall = z.infer<typeof recallSchema>;
const normalize = (text: string) => text.normalize('NFKC').toLowerCase();
const failure = (code: string, message: string) => Object.assign(new Error(message), { code });
type Receipt = DefinitionReceipt<UsageSession>;
type Match = { node: UsageNode; score: number; reason: Record<string, unknown> };

/** Optional procedural memory. It never invokes tools, advances a Plan, judges
 * completion, or requests another model. Native receipts remain the only facts. */
export class UsageGuidance {
  readonly store: DefinitionStore<UsageSession>;
  readonly #recall: DefinitionStore<Recall>;
  constructor(private readonly registry: ToolRegistry, private readonly executions: ToolExecutionStore, directory?: string,
    private readonly options: { coordination?: CoordinationStore; loadExtensions?: PluginExtensionLoader } = {}) {
    this.store = new DefinitionStore(value => usageSessionSchema.parse(value), directory);
    this.#recall = new DefinitionStore(value => recallSchema.parse(value), directory ? join(directory, 'recall') : undefined);
  }

  register() {
    this.registry.register({
      definition: {
        name: USAGE_TOOL,
        description: 'Author and inspect reusable task manuals. Teachers: guide explains the format; load get_tool_schema(name="usage") for fields. Describe recommended capabilities by purpose/query/behavior, package tested methods as recipes, and supply an ordered default plan of teaching node IDs. import(enabled:false) stages a draft; export returns the definition and installable CardBush plugin files. Users select installed manuals through their slash command, never automatic discovery or activation. After selection, reuse or adapt plan_template through the native update_task_plan; its usage references select current guidance and restore it after compaction. No second progress tool or teacher approval. recommend/recipe describe local capabilities and explicit run_tools methods. capture records receipt locators; review checks teaching coverage/provenance, not quality certification. Legacy direct imports remain supported. Examples are teaching data, never live facts or permissions.',
        // Describe accepted caller input, not the normalized output with defaults filled in.
        inputSchema: z.toJSONSchema(usageInputSchema, { io: 'input' }),
      },
      manifest: { effect_kind: 'runtime_state', operation: 'usage.manage', risk: 'low', owner: 'runtime', dispatch_scope: 'session', mutating: true },
      nestedCallable: false, visibleToChild: false,
      decodeInput: value => usageInputSchema.parse(value),
      execute: context => this.handle(context),
    });
  }

  #match(node: UsageNode, task: string, signal?: ToolExecutionSignal, definitionHash?: string): Match | undefined {
    let best: Match | undefined;
    for (const rule of node.when) {
      let reason: Record<string, unknown>, specificity: number;
      if (rule.on === 'task') {
        const terms = rule.terms.filter(term => task.includes(normalize(term)));
        if (!terms.length) continue;
        reason = { on: 'task', terms }; specificity = 1;
      } else if (rule.on === 'recipe_result') {
        if (!signal?.usageRecipe || signal.usageRecipe.definition_sha256 !== definitionHash ||
          !rule.recipes.includes(signal.usageRecipe.recipe_id) || rule.outcome !== 'any' && rule.outcome !== signal.outcome) continue;
        reason = { on: 'recipe_result', recipe_id: signal.usageRecipe.recipe_id, outcome: signal.outcome }; specificity = 4;
      } else {
        if (!signal || rule.tools.length && !rule.tools.includes(signal.tool) ||
          rule.outcome !== 'any' && rule.outcome !== signal.outcome ||
          rule.error_codes.length && !rule.error_codes.includes(signal.errorCode ?? '')) continue;
        reason = { on: 'tool_result', tool: signal.tool, outcome: signal.outcome,
          ...(signal.errorCode ? { error_code: signal.errorCode } : {}) };
        specificity = 2 + Number(rule.tools.length > 0) + Number(rule.error_codes.length > 0);
      }
      const candidate = { node, score: node.priority * 10 + specificity, reason };
      if (!best || candidate.score > best.score) best = candidate;
    }
    return best;
  }

  async #window(state: UsageSession) {
    const saved = await this.#recall.get(state.id);
    const sameActivation = saved && JSON.stringify(saved.definition.activation) === JSON.stringify(state.activated_after);
    const previous = sameActivation ? saved.definition : undefined;
    const fresh = this.executions.signalsAfter(state.id, previous?.cursor ?? state.activated_after);
    const meaningful = fresh.filter(isUsageBusinessSignal);
    // Two calls to the same tool may operate on different files. A later success
    // is not proof that an earlier failure was repaired; retain both outcomes.
    const signals = meaningful.length ? meaningful : previous?.signals ?? [];
    const last = fresh.at(-1);
    return { saved, definition: { id: state.id, activation: state.activated_after,
      cursor: last ? { turnId: last.turnId, toolCallId: last.toolCallId } : previous?.cursor ?? state.activated_after,
      signals } };
  }

  async #view(receipt: Receipt, request: ModelRequest | undefined, messages: ModelMessage[], signals: ToolExecutionSignal[], fullPlan = false) {
    const state = receipt.definition;
    const plugin = await this.pluginState(request, undefined, state);
    const enabled = state.enabled && plugin.available && request?.metadata.usageGuidanceEnabled !== false;
    const plan = usagePlanView(state.usage, this.options.coordination?.getPlan(state.id), state.plan_revision_at_load);
    const deferredPlan = !fullPlan && JSON.stringify(plan).length > 5000;
    if (deferredPlan) {
      delete plan.plan_template;
      if (plan.native_plan) plan.native_plan.nodes = [];
    }
    const base = plan.phase === 'completed' || plan.phase === 'adapted' ? undefined
      : state.usage.nodes.find(node => node.id === (plan.current_node ?? state.focus ?? state.usage.entry_node))!;
    const latestTask = (items: ModelMessage[]) => [...items].reverse()
      .find(message => message.role === 'user' && !message.name && message.visibility !== 'internal')?.content;
    // Compaction can remove the raw user message from the working transcript.
    // The original request remains available; prefer newer live user input.
    const task = normalize(latestTask(messages) ?? latestTask(request?.messages ?? []) ?? '');
    const definitionHash = usageDefinitionHash(state.usage);
    const available = new Set(usageAvailableTools(this.registry, request).map(item => item.name));
    const matches = enabled && plan.phase !== 'completed' ? state.usage.nodes.filter(node => node.id !== base?.id && !state.usage.plan.includes(node.id))
      .flatMap(node => {
        const candidates = [this.#match(node, task), ...signals.map(signal => this.#match(node, '', signal, definitionHash))]
          .filter((match): match is Match => !!match).sort((a, b) => b.score - a.score);
        return candidates.slice(0, 1);
      })
      .sort((left, right) => right.score - left.score || left.node.id.localeCompare(right.node.id)) : [];
    const chosen = enabled ? [...(base ? [{ node: base, reason: { on: plan.current_node ? 'native_plan' : state.focus ? 'focus' : 'entry' } }] : []), ...matches] : [];
    const view = {
      revision: receipt.revision, enabled, session_id: state.id, usage_id: state.usage.id, name: state.usage.name,
      objective: state.usage.objective, focus: state.focus,
      ...(state.usage.plan.length ? { plan } : {}),
      ...(deferredPlan ? { deferred_plan: 'Use usage status for the full default plan template, or update_task_plan(action=get) for the current native plan. Current-node guidance is preserved.' } : {}),
      ...(state.plugin ? { plugin: { command_id: state.plugin.command_id, available: plugin.available, ...(plugin.reason ? { reason: plugin.reason } : {}) } } : {}),
      constraints: enabled ? state.usage.constraints : [],
      quality_criteria: enabled ? state.usage.criteria : [],
      selected: chosen.map(({ node, reason }) => ({ id: node.id, name: node.name, reason,
        instruction: node.instruction, adaptation: node.adaptation, checks: node.checks,
        decisions: node.decisions,
        recommendations: node.recommendations,
        recipes: node.recipes,
        capabilities: node.capabilities.map(capability => usageToolHint(this.registry, request, capability, available)),
        demonstrations: node.examples,
      })),
      teaching_evidence: [] as UsageEvidence[],
      recommended_capabilities: [] as Array<{ id: string; purpose: string; inspect: { action: string; capability_id: string } }>,
      methods: [] as Array<{ id: string; name: string; inspect: { action: string; recipe_id: string } }>,
      asset_root: enabled ? state.asset_root : null,
      deferred_evidence: [] as string[],
      deferred_lessons: [] as Array<{ id: string; name: string }>,
      diagnostics: { ...(signals.length ? { signal: signals.at(-1) } : {}), signals,
        matched_nodes: matches.map(match => ({ id: match.node.id, reason: match.reason })),
        selection: 'Native plan usage references select the current teaching node; legacy packs use entry/focus. Additional result lessons exclude other default-plan nodes. Native results since the previous model request form one batch. status does not consume results or update progress.' },
    };
    const selectEvidence = () => {
      const ids = new Set(view.selected.flatMap(node => node.demonstrations.flatMap(example => [
        ...example.assessments.flatMap(assessment => assessment.evidence_ids),
        ...(example.comparison ? [example.comparison.before, example.comparison.after] : []),
      ])));
      view.teaching_evidence = state.usage.evidence.filter(item => ids.has(item.id));
      const recipes = new Set(view.selected.flatMap(node => node.recipes));
      const capabilities = new Set([...view.selected.flatMap(node => node.recommendations), ...state.usage.recipes.filter(item => recipes.has(item.id)).flatMap(item => item.requires)]);
      view.recommended_capabilities = state.usage.capabilities.filter(item => capabilities.has(item.id))
        .map(item => ({ id: item.id, purpose: item.purpose, inspect: { action: 'recommend', capability_id: item.id } }));
      view.methods = state.usage.recipes.filter(item => recipes.has(item.id))
        .map(item => ({ id: item.id, name: item.name, inspect: { action: 'recipe', recipe_id: item.id } }));
    };
    selectEvidence();
    // Reserve room for the envelope/notice. Preserve the base lesson and quality
    // criteria even when evidence is large; export exposes any deferred locators.
    while (view.selected.length > 1 && JSON.stringify({ ...view, diagnostics: undefined }).length > USAGE_CONTEXT_MAX_CHARS - 1800) {
      const omitted = view.selected.pop()!;
      view.deferred_lessons.unshift({ id: omitted.id, name: omitted.name });
      selectEvidence();
    }
    while (view.teaching_evidence.length && JSON.stringify({ ...view, diagnostics: undefined }).length > USAGE_CONTEXT_MAX_CHARS - 1800) {
      view.deferred_evidence.unshift(view.teaching_evidence.pop()!.id);
    }
    if (JSON.stringify({ ...view, diagnostics: undefined }).length > USAGE_CONTEXT_MAX_CHARS - 1800) {
      // Long tool identifiers and many deferred lesson names can dominate the
      // budget. Keep callable routes and teaching content; omit repeated prose.
      const compact = { ...view, deferred_lessons: view.deferred_lessons.map(({ id }) => ({ id })),
        recommended_capabilities: view.recommended_capabilities.map(({ id }) => ({ id })),
        methods: view.methods.map(({ id }) => ({ id })),
        selected: view.selected.map(node => ({ ...node, capabilities: node.capabilities.map(capability => {
          if (!('description' in capability)) return capability;
          const { description: _description, note: _note, ...route } = capability;
          return route;
        }) })) };
      if (JSON.stringify({ ...compact, diagnostics: undefined }).length <= USAGE_CONTEXT_MAX_CHARS - 1800) return compact;
      return { ...compact, asset_root: null, deferred_details: 'Use status for asset_root, export for deferred items, recommend(capability_id) or recipe(recipe_id) for method details.',
        deferred_evidence: [], deferred_evidence_count: compact.deferred_evidence.length,
        deferred_lessons: [], deferred_lesson_count: compact.deferred_lessons.length,
        selected: compact.selected.map(node => ({ ...node, capabilities: node.capabilities.map(({ tool, available }) => ({ tool, available })) })) };
    }
    return view;
  }

  async handle(context: ToolHandlerContext<UsageInput>): Promise<unknown> {
    const input = context.input, sessionId = context.sessionId;
    const review = (value: unknown) => reviewUsage(value, { sessionId, executions: this.executions, registry: this.registry, request: context.turn?.request });
    // Authoring assistance does not install a pack or depend on stored state.
    if (input.action === 'guide') return usageAuthoringGuide();
    if (input.action === 'capture') return captureUsageEvidence(this.executions, sessionId, context.turnId, input);
    if (input.action === 'review' && input.usage !== undefined) return review(input.usage);
    let receipt = await this.store.get(sessionId);
    if (input.action === 'review') return receipt ? review(receipt.definition.usage)
      : { valid: false, quality_verified: false, issues: [{ code: 'usage_not_found', message: 'Provide a draft in usage or import one first. Nothing was changed.' }] };
    if (input.action === 'recommend' || input.action === 'recipe') {
      if (!receipt) throw failure('usage_not_found', 'Import a usage pack first.');
      if (input.action === 'recommend') {
        const capability = receipt.definition.usage.capabilities.find(item => item.id === input.capability_id);
        if (!capability) throw failure('usage_capability_not_found', 'Choose a capability ID from the current usage pack.');
        return recommendUsageCapability(this.registry, context.turn?.request, capability);
      }
      const pack = receipt.definition.usage;
      const recipe = pack.recipes.find(item => item.id === input.recipe_id);
      if (!recipe) throw failure('usage_recipe_not_found', 'Choose a method ID from the current usage pack.');
      return { ...usageRecipeInfo(recipe, receipt.revision), capabilities: recipe.requires.map(id => pack.capabilities.find(item => item.id === id)!) };
    }
    if (input.action === 'status') return receipt
      ? { ...await this.#view(receipt, context.turn?.request, context.turn?.contextMessages ?? [], (await this.#window(receipt.definition)).definition.signals, true),
        installed: true, scope: 'session', asset_root: receipt.definition.asset_root,
        nodes: receipt.definition.usage.nodes.map(node => ({ id: node.id, name: node.name })) }
      : { installed: false, scope: 'session', enabled: false, revision: 0, selected: [],
        note: 'No usage pack has been imported into this conversation. This is an empty session state, not a disabled or failed capability. Use guide to author a pack, or import an existing definition; packs are not automatically shared across conversations.' };
    if (input.action === 'export') {
      if (!receipt) throw failure('usage_not_found', 'No usage pack is installed in this conversation.');
      return { filename: `${receipt.definition.usage.id}.usage.json`, definition: receipt.definition.usage,
        package: exportUsagePackage(receipt.definition.usage),
        assets_to_package: receipt.definition.usage.evidence.flatMap(item => item.source.kind === 'asset' ? [{ id: item.id, ...item.source }] : []),
        note: 'Save the definition and include referenced assets with ordinary file tools. Only author-provided teaching content and evidence locators are exported, not receipt bodies, session state or permissions. Assets are not copied or opened; assessments are not quality certificates. Use review to inspect teaching gaps before transfer.' };
    }
    if (receipt?.definition.plugin && ['import', 'enable', 'disable'].includes(input.action)) {
      throw failure('usage_user_selection_required', '此手册由用户选择的插件管理。请由用户使用对应的 use/stop 命令切换或停用；模型不能自行替换所选手册。');
    }
    if ((receipt?.revision ?? 0) !== input.expected_revision) throw failure('usage_revision_conflict', 'Read status and use its current revision.');
    const marker = { turnId: context.turnId, toolCallId: context.toolCall.id };
    if (input.action === 'import') {
      receipt = await this.store.put({ id: sessionId, usage: input.usage, enabled: input.enabled, focus: null,
        plan_revision_at_load: this.options.coordination?.getPlan(sessionId)?.revision ?? 0,
        asset_root: input.asset_root ?? null, activated_after: marker }, input.expected_revision);
    } else {
      if (!receipt) throw failure('usage_not_found', 'Import a usage pack first.');
      const state = receipt.definition;
      if (input.action === 'focus') state.focus = input.node_id;
      else {
        const enable = input.action === 'enable';
        if (enable && !state.enabled) {
          state.activated_after = marker;
          state.plan_revision_at_load = this.options.coordination?.getPlan(sessionId)?.revision ?? 0;
        }
        state.enabled = enable;
      }
      receipt = await this.store.put(state, receipt.revision);
    }
    const view = await this.#view(receipt, context.turn?.request, context.turn?.contextMessages ?? [], (await this.#window(receipt.definition)).definition.signals);
    if (input.action === 'import') {
      const report = review(receipt.definition.usage);
      return { ...view, authoring: { quality_verified: false, issue_count: report.issue_count,
        inspect: { action: 'review' }, note: 'Review teaching gaps and actual outcomes before calling this a validated teacher sample.' } };
    }
    return view;
  }

  async context(request: ModelRequest, messages: ModelMessage[]): Promise<ModelMessage | undefined> {
    if (request.metadata.agentRole === 'child' || !request.tools.some(tool => tool.name === USAGE_TOOL)) return;
    const last = [...messages].reverse().find(message => message.role === 'user' && message.name === USAGE_CONTEXT_NAME);
    let content: string;
    try {
      const receipt = await this.store.get(request.sessionId);
      if (!receipt && !last) return;
      const window = receipt ? await this.#window(receipt.definition) : undefined;
      const view = receipt ? await this.#view(receipt, request, messages, window!.definition.signals) : undefined;
      if (!view?.enabled) {
        if (!last) return;
        content = JSON.stringify({ session_id: request.sessionId, enabled: false,
        notice: 'Usage guidance is disabled or its plugin source is unavailable. Previous usage examples are inactive. Inspect status for the reason; required plugin guards remain enforced until the user stops or reloads the manual.' });
      } else {
        const { diagnostics: _diagnostics, ...guidance } = view;
        content = JSON.stringify({ protocol: 'bush.usage_context.v1', ...guidance,
          notice: 'User-selected teaching data for this session, subject to current user instructions and host permissions. Reuse or adapt plan_template using native update_task_plan; preserve its usage references so guidance follows the current node. The native plan is the only progress state; no teacher approval or per-node completion submission. Use applicable Skills and current tools for execution. Demonstrations describe other situations, never current observations, paths, receipts or proof of quality. Derive parameters from this task, observe, repair and self-check. Evidence assets are relative to asset_root and are not opened or certified. export exposes deferred items. No tool access grant or retry authorization. Finish normally when the requested outcome is verified.' });
        if (content.length > USAGE_CONTEXT_MAX_CHARS) throw failure('usage_context_too_large', 'Usage guidance exceeds the context budget; shorten the active lessons.');
        if (JSON.stringify(window!.saved?.definition) !== JSON.stringify(window!.definition)) {
          await this.#recall.put(window!.definition, window!.saved?.revision ?? 0);
        }
      }
    } catch (error) {
      // This optional aid must not break otherwise independent execution.
      content = JSON.stringify({ session_id: request.sessionId, enabled: false, unavailable: true,
        notice: 'Usage guidance could not be restored. Continue from actual user instructions and tool facts; do not assume earlier guidance is current. Inspect usage status if needed.',
        error: (error instanceof Error ? error.message : String(error)).slice(0, 500) });
    }
    if (last?.content === content) return;
    return { role: 'user', name: USAGE_CONTEXT_NAME, visibility: 'internal', content };
  }

  async removeSession(sessionId: string) {
    await this.store.discard(sessionId);
    await this.#recall.discard(sessionId);
  }

  /** Only the user's native plugin command can mount/unmount an installed manual. */
  async loadCommand(command: PluginCommand, context: ToolHandlerContext<unknown>): Promise<string> {
    const source = command.usage;
    if (!source || context.turn?.request.metadata.agentRole === 'child' ||
      context.turn?.request.metadata.pluginCommandUserCallId !== context.toolCall.id || context.turn.request.metadata.pluginCommandUserId !== command.id) {
      throw failure('usage_user_selection_required', '请由用户选择 usage 命令。');
    }
    const saved = await this.store.get(context.sessionId);
    if (source.action === 'unload') {
      if (!saved?.definition.plugin) return '当前会话未加载插件手册。';
      if (!saved.definition.plugin.command_id.startsWith(`${command.pluginId}:`) || saved.definition.usage.id !== source.definition.id) {
        throw failure('usage_plugin_mismatch', '此命令不属于当前加载的手册。');
      }
      await this.store.put({ ...saved.definition, enabled: false }, saved.revision);
      return '手册已停用，相关 Hooks 已退出当前会话；原生计划未改动。';
    }
    const extensions = await this.options.loadExtensions?.();
    if (!extensions?.commands?.some(item => item.id === command.id && item.usage?.sourceHash === source.sourceHash)) {
      throw failure('usage_plugin_changed', '插件已变化或停用，请重新选择当前版本。');
    }
    if (!source.guardHashes.every(hash => extensions.hooks.some(hook => hook.definitionHash === hash && hook.trusted === true))) {
      throw failure('usage_guard_unavailable', '此手册包含执行前 guard，请先在插件设置中信任其 Hooks；未加载手册。');
    }
    await this.store.put({ id: context.sessionId, usage: usageDefinitionSchema.parse(source.definition), enabled: true, focus: null,
      plan_revision_at_load: this.options.coordination?.getPlan(context.sessionId)?.revision ?? 0,
      asset_root: command.root, activated_after: { turnId: context.turnId, toolCallId: context.toolCall.id },
      plugin: { command_id: command.id, definition_sha256: source.sourceHash, guard_hashes: source.guardHashes } }, saved?.revision ?? 0);
    return '手册已加载。请根据当前任务复用或调整 plan_template，使用 update_task_plan 更新进度；节点指导随计划恢复。';
  }

  async pluginState(request?: ModelRequest, extensions?: PluginExtensions, definition?: UsageSession) {
    // With no installed usage commands there can be no live scoped guard. Do
    // not make an old/corrupt optional authoring draft block unrelated hooks.
    if (!definition && extensions && !extensions.commands?.some(command => command.usage)) {
      return { available: true, commandId: undefined, blocked: undefined, reason: undefined };
    }
    const state = definition ?? (request ? (await this.store.get(request.sessionId))?.definition : undefined);
    if (!state?.plugin || !state.enabled || request?.metadata.agentRole === 'child') return { available: true, commandId: undefined, blocked: undefined, reason: undefined };
    const current = extensions ?? await this.options.loadExtensions?.();
    const installed = current?.commands?.find(command => command.id === state.plugin!.command_id);
    const source = installed?.usage?.sourceHash === state.plugin.definition_sha256 ? installed : undefined;
    const available = Boolean(source && state.plugin.guard_hashes.every(hash => current!.hooks.some(hook => hook.definitionHash === hash && hook.trusted === true)));
    const reason = available ? undefined : '所选 usage 插件已停用、内容变化或必需 guard 不可用。请使用该插件的 use 命令重新加载，或由用户使用 stop 命令停用。';
    return { available, commandId: available ? source!.id : undefined, reason,
      // Removing/disabling the plugin also removes this invocation's authority.
      // A still-installed but changed/untrusted guard must never silently weaken.
      blocked: !available && installed && state.plugin.guard_hashes.length ? reason : undefined };
  }

  async prepareRecipe(context: ToolHandlerContext<unknown>, input: UsageRecipeInvocation) {
    if (context.turn?.request.metadata.agentRole === 'child' || !context.turn?.request.tools.some(tool => tool.name === USAGE_TOOL)) {
      throw failure('usage_recipe_not_exposed', 'Usage methods are unavailable in this execution scope.');
    }
    const receipt = await this.store.get(context.sessionId);
    if (!receipt) throw failure('usage_not_found', 'Import the teaching pack before running one of its methods.');
    if (receipt.definition.plugin && !receipt.definition.enabled) throw failure('usage_plugin_inactive', 'This manual was stopped by the user. Select its use command to run its methods again.');
    if (!(await this.pluginState(context.turn?.request, undefined, receipt.definition)).available) throw failure('usage_plugin_unavailable', 'Reload the selected usage plugin before running its methods.');
    return prepareUsageRecipe(receipt, input, context, this.registry);
  }
}
