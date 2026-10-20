import { createHash } from 'node:crypto';
import { toolExecutionError, usageDefinitionSchema, type ModelRequest, type ToolExecutionRecord, type UsageEvidence, type UsageInput } from '@cardbush/bush-protocol';
import type { ToolExecutionStore } from './toolExecutionStore.js';
import type { ToolRegistry } from './toolRegistry.js';
import { isUsageBusinessSignal, usageRecipeFromRecord } from './usageSignals.js';
import { usageAvailableTools } from './usageCapabilities.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const receiptHash = (record: ToolExecutionRecord) => hash({ tool: record.toolCall.name, arguments: record.toolCall.argumentsText,
  outcome: record.outcome, result: record.result, resultError: record.resultError, error: record.error });

/** Only current-session receipts are addressable. Captures contain no arguments,
 * result bodies, file contents or hidden model reasoning. */
export function captureUsageEvidence(executions: ToolExecutionStore, sessionId: string, turnId: string, input: Extract<UsageInput, { action: 'capture' }>) {
  const turn = input.turn_id ?? turnId;
  let ids = input.tool_call_ids;
  if (!ids) ids = executions.listTurnSummaries(sessionId, turn)
    .filter(record => {
      const full = record.toolCall.name === 'script_completion' ? executions.get(sessionId, turn, record.toolCall.id) : undefined;
      return isUsageBusinessSignal({ tool: record.toolCall.name, outcome: record.outcome === 'cancelled' ? 'cancelled' : toolExecutionError(record) ? 'failed' : record.outcome,
        ...(full ? { usageRecipe: usageRecipeFromRecord(full) } : {}) });
    })
    .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt)).slice(-input.limit).map(record => record.toolCall.id);
  const evidence = [...new Set(ids)].map(toolCallId => {
    const record = executions.get(sessionId, turn, toolCallId);
    if (!record) throw Object.assign(Error('Receipt not found in this conversation and turn. Use capture without IDs to list recent receipts.'), { code: 'usage_evidence_not_found' });
    const outcome = record.outcome === 'cancelled' ? 'cancelled' : toolExecutionError(record) ? 'failed' : record.outcome;
    const item: UsageEvidence = {
      id: `receipt-${hash([sessionId, turn, toolCallId]).slice(0, 16)}`,
      description: `${record.toolCall.name}: ${outcome}. Execution evidence only; assess the actual result separately.`,
      source: { kind: 'tool_receipt', session_id: sessionId, turn_id: turn, tool_call_id: toolCallId, sha256: receiptHash(record) },
    };
    return item;
  });
  return { evidence, note: 'Copy relevant locators into the pack, then add your own observations and criterion assessments. Capture proves receipt identity, not design quality or teacher superiority. Inspect actual artifacts with ordinary tools; package visual examples as relative assets. No state was changed.' };
}

export function usageAuthoringGuide() {
  return {
    purpose: 'Teach a repeatable task method with default plan nodes, demonstrations and parameter adaptation. The user selects the manual; the student reuses or adapts its plan through CardBush update_task_plan and executes without teacher approval.',
    authoring_scope: 'The definition remains the export source; export also generates usage.md and native CardBush plugin files, so authors do not duplicate prose in two formats. Add plan as an ordered list of node IDs (at most 20). Each planned node should explain its outcome, actual example, why the method was chosen and what omission costs, at least two alternative directions with applicability/tradeoffs, parameter adaptation and completion cues. Unobserved alternatives must be labeled as proposals. Keep optional criteria/evidence/recipes proportional to the task; review reports gaps without gating every step. Reuse Skills and plugins for underlying execution. No other Agent adapters or second plan manager are required.',
    workflow: [
      'Define outcome criteria before making the teacher sample. Separate content/visual/behavioral quality from export, syntax and tool-success checks.',
      'Produce and inspect the actual sample using ordinary tools. Record visible shortcomings and revisions. For comparisons hold the brief, content and constraints constant; do not assume a stronger model produced the better sample.',
      'Use capture to obtain actual receipt locators. Add before/after screenshots or other result evidence as portable asset references; capture itself never observes an image or certifies quality.',
      'Organize the default execution plan using stable node IDs. For each node record the desired outcome, actual actions, observable cues, chosen approach, concise reason and downside of skipping it, at least two alternatives with applicability/tradeoffs, parameter derivation and completion cues. Distinguish demonstrated results from untested alternatives. Transfer these public explanations, not hidden reasoning transcripts.',
      'Describe recommended capabilities by purpose, search keywords and expected behavior, not plugin/Skill/tool names. Students use recommend to find compatible current implementations. CardBush reads the current native plan node to supply its lesson. Keep result-triggered recovery lessons outside the default plan. Exact-name capabilities/triggers are legacy compatibility only.',
      'When a stable operation is worth encapsulating, add a recipe with typed business parameters, capability IDs in requires, and JavaScript using input and caps[capability_id](args). Import the draft with enabled:false before testing; inspect recipe and run it through run_tools with current bindings. Students reuse that code with their own business parameters. Reuse normal tools for file/library access; the sandbox has no Node/imports. Test on actual inputs, inspect the output and capture its completion before recommending it. Import/review never executes code.',
      'Write examples with observations, criterion assessments and evidence IDs. State what changed and what stayed constant in a comparison. Include a failure/counterexample and a recovery lesson when useful; do not invent evaluations.',
      'Call review with the draft definition. Resolve missing decisions, unassessed criteria, hard-coded implementation names and broken references. Explain the capability contract and units; teacher APIs, paths and UI IDs may differ from the student environment.',
      'Import with enabled:false to stage the teacher draft, then export. Write package.files and referenced assets into one directory or ZIP. Install through the normal CardBush plugin installer. Only the user invokes the exported use command; it loads the manual and provides plan_template for update_task_plan. The stop command deactivates the manual and its scoped hooks without editing progress. The student adapts and executes autonomously; no teacher approval or extra node-completion tool is added.',
    ],
    cardbush_extensions: {
      hooks: 'Attach normal CardBush hooks to commands/use.md frontmatter. They are scoped to this selected manual; no hook runs at export or installation. PostToolUse on update_task_plan observes native plan changes; PostToolUseFailure supplies recovery feedback. Ordinary commands may be added under commands/.',
      guards: 'PreToolUse hooks attached to a usage command are required guards: use synchronous command or mcp_tool handlers. Trust them in plugin settings before loading. Return the normal permissionDecision deny with a concrete reason to block the action. Inspection failure must not be reported as success. Changed or untrusted required guards pause dependent tool execution until user reload/stop; disabling the plugin withdraws its guidance and hooks.',
      command: 'Each usage loader is an explicit user-only native Command with usage: ./usage.json; use usage: {file: ./usage.json, action: unload} for stop. Business methods stay in recipes and execute through existing run_tools with declared capability bindings. Executable hooks/scripts use CardBush permissions and declared local dependencies.',
    },
    scope: 'review checks structure, teaching coverage and locally resolvable receipt identity only. It cannot judge aesthetics, open evidence, prove improvements or certify a teacher.',
    recipe_example: {
      note: 'Illustrative addition to the template: merge capabilities and recipes into the top-level arrays and node_fields into the compose node. Check the local implementation contract and test the method before teaching it.',
      capabilities: [{ id: 'inspect-file', kind: 'tool', purpose: 'Read the current file for content verification.',
        recommendation: 'Choose an inspection tool that reads the actual file and returns its content or a structural summary.', query: 'inspect file content structure',
        contract: 'Accepts an object with path:string, the actual local file path; returns content or structural data for that file. Bind only an implementation whose current schema and behavior match this contract.' }],
      recipes: [{ id: 'inspect-current-file', name: 'Inspect a current file', description: 'Illustrative inspection wrapper, not a quality verdict.',
        parameters: [{ name: 'path', type: 'string', required: true, description: 'Actual file selected for the current task.' }], requires: ['inspect-file'],
        code: 'const result = await caps["inspect-file"]({path: input.path}); return result;' }],
      node_fields: { recipes: ['inspect-current-file'] },
    },
    template_note: 'Illustrative, intentionally unassessed draft. Replace its task, criteria and observations with actual work; it is not a validated teacher sample.',
    template: {
      protocol: 'bush.usage.v1', id: 'readable-layout', name: 'Readable content layout', objective: 'Organize the requested content so its hierarchy is clear without losing information.', entry_node: 'compose', plan: ['compose'],
      capabilities: [{ id: 'inspect-layout', kind: 'tool', purpose: 'Observe actual page layout.', recommendation: 'Prefer a tool that renders the real artifact and exposes visible bounds rather than merely confirming export.', query: 'render document page image layout', contract: 'Inspect the target tool schema for file path, page selection and returned image location.' }],
      criteria: [{ id: 'hierarchy', name: 'Clear reading order', kind: 'outcome', method: 'visual',
        inspect: 'Inspect the actual rendered page at the intended viewing size.', accept: 'The main point is apparent first; supporting sections are separated and readable.',
        revise: 'Reduce competing emphasis and redistribute space; preserve required content.' }],
      nodes: [{ id: 'compose', name: 'Choose a layout from the content', instruction: 'Inspect the brief and content density before choosing sections. Render and inspect the real result before delivery.', recommendations: ['inspect-layout'],
        decisions: [{ situation: 'The page mixes one main claim with several supporting facts.', choice: 'Give the claim a clear primary area and group supporting facts by purpose.',
          reason: 'Equal visual weight can hide the reading order.', alternatives: [{ choice: 'Give every item an equally prominent card.', tradeoff: 'Untested alternative: useful for peer items, but weakens the hierarchy of a main claim.' },
            { choice: 'Use a sequential narrative with one point per section.', tradeoff: 'Untested alternative: useful when order matters; consumes more space and makes side-by-side comparison harder.' }],
          parameters: [{ name: 'text size and section spacing', derive_from: 'The target viewport, content density and actual rendered text bounds.', adjust_when: 'Text crowds neighboring sections or supporting details compete with the main point.' }], criteria: ['hierarchy'] }],
        examples: [{ situation: 'Replace with a real sample and its constraints.', steps: [{ observation: 'No sample has been observed in this template.' }],
          lesson: 'Explain which visible cue justified the decision and when another layout is better.', assessments: [{ criterion: 'hierarchy', verdict: 'unreviewed', observation: 'Inspect an actual render before making a quality claim.', evidence_ids: [] }] }],
      }],
    },
  };
}

/** Author feedback, never an execution gate or an automatic quality grader. */
export function reviewUsage(value: unknown, context: { sessionId: string; executions: ToolExecutionStore; registry: ToolRegistry; request?: ModelRequest }) {
  const parsed = usageDefinitionSchema.safeParse(value);
  if (!parsed.success) return { valid: false, quality_verified: false, issues: parsed.error.issues.slice(0, 40).map(issue => ({ path: issue.path.join('.'), message: issue.message })),
    note: 'Fix the definition and review again. Nothing was imported or executed.' };
  const pack = parsed.data;
  const issues: Array<{ code: string; path: string; message: string }> = [];
  const warn = (code: string, path: string, message: string) => issues.push({ code, path, message });
  const outcomes = pack.criteria.filter(criterion => criterion.kind === 'outcome');
  const toolNames = new Set(usageAvailableTools(context.registry, context.request).map(item => item.name));
  const available = (name: string) => toolNames.has(name);
  if (!pack.plan.length) warn('missing_default_plan', 'plan', 'Add the ordered teaching node IDs for a repeatable task. Legacy packs remain usable, but they have no native-plan template to follow.');
  if (!outcomes.length) warn('missing_outcome_criteria', 'criteria', 'Describe what makes the result good. Tool success, valid structure and exportability are process checks, not sufficient outcome criteria.');
  const evidence = pack.evidence.map(item => {
    const source = item.source;
    if (source.kind !== 'tool_receipt') return { id: item.id, provenance: 'not_opened', quality: 'not_verified' };
    if (source.session_id !== context.sessionId) return { id: item.id, provenance: 'external_receipt_not_checked', quality: 'not_verified' };
    const record = context.executions.get(context.sessionId, source.turn_id, source.tool_call_id);
    const matches = record && receiptHash(record) === source.sha256;
    if (!matches) warn('receipt_mismatch', `evidence.${item.id}`, 'This locator does not match a current local receipt. Recapture it or label it as an external reference; do not present it as verified.');
    return { id: item.id, provenance: matches ? 'matched_local_receipt' : 'missing_or_changed', quality: 'not_verified' };
  });
  let decisions = 0, examples = 0, comparisons = 0;
  const assessed = new Set<string>(), evidenced = new Set<string>();
  for (const [index, node] of pack.nodes.entries()) {
    const path = `nodes.${index}`; decisions += node.decisions.length; examples += node.examples.length;
    if (pack.plan.includes(node.id)) {
      if (!node.examples.length) warn('missing_node_example', path, 'Provide this stage’s actual example or label an illustrative case as untested.');
      if (!node.checks.length) warn('missing_completion_cues', path, 'Explain when the student can proceed from this node; this is guidance, not a per-node approval gate.');
    }
    if (!node.decisions.length) warn('missing_decision', path, 'Add the cue, chosen approach and why it fits, not just a list of tools to call.');
    node.decisions.forEach((decision, d) => {
      if (!decision.parameters.length && !node.adaptation.length) warn('missing_adaptation', `${path}.decisions.${d}`, 'Explain which parameters the student derives from current facts and what would change the choice.');
      if (decision.alternatives.length < (pack.plan.includes(node.id) ? 2 : 1)) warn('missing_tradeoff', `${path}.decisions.${d}`, 'For planned nodes, explain at least two alternative directions and when each is better or worse. Label untested proposals.');
      if (!decision.criteria.length) warn('decision_without_criteria', `${path}.decisions.${d}`, 'Link the decision to an observable quality criterion.');
    });
    for (const [e, example] of node.examples.entries()) {
      if (example.comparison) comparisons++;
      if (!example.assessments.length) warn('unassessed_example', `${path}.examples.${e}`, 'Record observations against criteria; successful generation alone does not establish a good example.');
      for (const assessment of example.assessments) {
        if (assessment.verdict === 'unreviewed') continue;
        assessed.add(assessment.criterion);
        if (assessment.evidence_ids.length) evidenced.add(assessment.criterion);
        else warn('unsupported_assessment', `${path}.examples.${e}`, `The ${assessment.criterion} judgment has no evidence locator. Record the inspected result, including failures.`);
        const criterion = pack.criteria.find(item => item.id === assessment.criterion)!;
        if (criterion.method === 'visual' && assessment.evidence_ids.length && assessment.evidence_ids.every(key => pack.evidence.find(item => item.id === key)?.source.kind === 'tool_receipt')) {
          warn('visual_evidence_missing', `${path}.examples.${e}`, 'A receipt fingerprint cannot show visual quality. Include the inspected render/reference and describe the visible result.');
        }
      }
    }
    for (const capability of node.capabilities) {
      warn('implementation_name_coupling', `${path}.capabilities`, 'This legacy recommendation requires an exact implementation name. Prefer a purpose/query capability and let the student discover a compatible local tool.');
      if (!available(capability.tool)) warn('target_capability_unavailable', `${path}.capabilities`, `${capability.tool} is unavailable in this scope. Verify the student's tool/API/units or describe an available alternative before transfer.`);
    }
    for (const [r, rule] of node.when.entries()) {
      if (rule.on !== 'tool_result') continue;
      if (rule.tools.length) warn('implementation_name_coupling', `${path}.when.${r}`, 'This lesson is tied to implementation names. Prefer a packaged method result or a general result outcome with applicability cues.');
      for (const name of rule.tools) {
        if (!available(name)) warn('trigger_tool_unavailable', `${path}.when.${r}`, `${name} is unavailable here; verify the native tool name in the target environment so this lesson can be recalled.`);
      }
      const outcomes = rule.outcome === 'any' ? ['returned', 'failed', 'cancelled'] as const : [rule.outcome];
      if (rule.tools.length && !rule.tools.some(tool => outcomes.some(outcome => isUsageBusinessSignal({ tool, outcome })))) {
        warn('ignored_trigger', `${path}.when.${r}`, 'This rule only matches administrative or successful coordination receipts, which do not trigger lessons. Use the actual native business tool/outcome from capture.');
      }
    }
  }
  for (const criterion of outcomes) if (!assessed.has(criterion.id)) warn('outcome_not_assessed', `criteria.${criterion.id}`, 'No example has an observed assessment for this outcome criterion. Inspect the teacher sample before calling it successful.');
  if (!examples) warn('missing_examples', 'nodes', 'Provide an observed case or clearly labeled illustrative example, including the decision and result.');
  if (!comparisons) warn('no_comparison', 'nodes', 'No controlled comparison is recorded. A useful recipe can still be exported, but superiority or capability transfer has not been established.');
  for (const [index, recipe] of pack.recipes.entries()) {
    if (/\btools\s*(?:\.|\[)/.test(recipe.code)) warn('recipe_implementation_coupling', `recipes.${index}.code`, 'Use caps with declared capability IDs instead of hard-coded tools. Only explicitly bound dependencies are callable.');
    if (!pack.nodes.some(node => node.recipes.includes(recipe.id))) warn('unreferenced_recipe', `recipes.${index}`, 'No lesson recommends this method. Link it from an appropriate node so the student can discover it.');
    for (const id of recipe.requires) if (!pack.capabilities.find(item => item.id === id)?.contract) warn('missing_capability_contract', `recipes.${index}.requires`, `Describe the expected arguments and results for ${id}, so the student can check compatibility before binding.`);
    warn('recipe_not_execution_verified', `recipes.${index}`, 'Review does not execute or certify method code. Test it with actual inputs using run_tools and assess the resulting artifacts before teaching it.');
  }
  return { valid: true, quality_verified: false, review_scope: 'teaching_structure_and_local_receipt_identity',
    coverage: { decisions, examples, comparisons, outcome_criteria: outcomes.length, assessed_outcomes: outcomes.filter(item => assessed.has(item.id)).length,
      outcomes_with_evidence_locators: outcomes.filter(item => evidenced.has(item.id)).length },
    issues: issues.slice(0, 64), issue_count: issues.length, evidence,
    assets_to_package: pack.evidence.flatMap(item => item.source.kind === 'asset' ? [{ id: item.id, ...item.source }] : []),
    note: 'Assessments are author reports. Matching receipts establish provenance only; assets/references were not opened or copied. Review does not certify quality, prove the teacher is better, execute examples, modify the pack, or block autonomous student work.' };
}
