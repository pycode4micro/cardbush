import { z } from 'zod';

export const USAGE_TOOL = 'usage' as const;
export const USAGE_PROTOCOL = 'bush.usage.v1' as const;
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/);
const tool = z.string().trim().min(1).max(200);
const text = (max: number) => z.string().trim().min(1).max(max);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
/** A reference on the host's own plan node, never a second progress store. */
export const usagePlanBindingSchema = z.object({ usage_id: id, node_id: id, definition_sha256: digest }).strict();
const assetPath = text(400).refine(value => !value.includes('\\') && !value.startsWith('/') &&
  !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) && !value.split('/').some(part => ['..', '.', ''].includes(part)),
  'Use a portable path relative to the usage bundle, never an absolute path or parent traversal.');
const assetRoot = text(2000).refine(value => value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value),
  'Use the absolute local directory containing this usage bundle. This is a locator, not a permission grant.');

export const usageCriterionSchema = z.object({
  id, name: text(120), kind: z.enum(['outcome', 'process']),
  method: z.enum(['visual', 'structural', 'behavioral', 'measurement']),
  inspect: text(600).describe('What to observe in the actual result, at what scale or under what conditions.'),
  accept: text(600).describe('Observable signs of an adequate outcome; a successful tool call alone is insufficient.'),
  revise: text(400).describe('What to change when this criterion is not met.'),
}).strict();

export const usageEvidenceSchema = z.object({
  id, description: text(600),
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('tool_receipt'), session_id: text(1000), turn_id: text(1000), tool_call_id: text(1000), sha256: digest }).strict(),
    z.object({ kind: z.literal('asset'), path: assetPath, sha256: digest.optional() }).strict(),
    z.object({ kind: z.literal('reference'), locator: text(1000) }).strict(),
  ]).describe('Evidence locator, not an automatic quality certification. Assets must be included separately when packaging.'),
}).strict();
export type UsageEvidence = z.infer<typeof usageEvidenceSchema>;

export const usageCapabilitySchema = z.object({
  id, kind: z.enum(['tool', 'skill']).default('tool'), purpose: text(300),
  recommendation: text(500).describe('What capability is useful and why, without requiring a plugin, Skill or tool name.'),
  query: text(300).describe('Capability keywords for discovery in the current environment, not an implementation identifier.'),
  contract: text(600).optional().describe('For a wrapped method, describe the expected input/output behavior so the student can choose a compatible implementation.'),
}).strict();
export type UsageCapability = z.infer<typeof usageCapabilitySchema>;
export const usageRecipeSchema = z.object({
  id, name: text(120), description: text(600),
  parameters: z.array(z.object({ name: id, type: z.enum(['string', 'number', 'integer', 'boolean', 'object', 'array']),
    description: text(400), required: z.boolean().default(true) }).strict()).max(12),
  requires: z.array(id).max(8).default([]),
  code: text(24000).describe('Reusable JavaScript async body. Read business parameters from input and call capabilities through caps[capability_id](args). Runs only when explicitly invoked through run_tools, in its existing sandbox and permissions.'),
}).strict().refine(value => new Set(value.parameters.map(item => item.name)).size === value.parameters.length && new Set(value.requires).size === value.requires.length,
  'Method parameters and required capability IDs must be unique.');
export type UsageRecipe = z.infer<typeof usageRecipeSchema>;

const decision = z.object({
  situation: text(500).describe('Observable cue that makes this decision applicable.'),
  choice: text(500), reason: text(500).describe('A concise public rationale or tradeoff, not a private reasoning transcript.'),
  alternatives: z.array(z.object({ choice: text(300), tradeoff: text(400) }).strict()).max(3).default([]),
  parameters: z.array(z.object({ name: text(120), derive_from: text(400), adjust_when: text(400) }).strict()).max(4).default([]),
  criteria: z.array(id).max(6).default([]),
}).strict();
const assessment = z.object({
  criterion: id, verdict: z.enum(['pass', 'fail', 'mixed', 'unreviewed']),
  observation: text(600), evidence_ids: z.array(id).max(6).default([]),
}).strict();

const trigger = z.discriminatedUnion('on', [
  z.object({ on: z.literal('task'), terms: z.array(text(80)).min(1).max(8) }).strict(),
  z.object({ on: z.literal('recipe_result'), recipes: z.array(id).min(1).max(6),
    outcome: z.enum(['any', 'returned', 'failed', 'cancelled']).default('any') }).strict(),
  z.object({
    on: z.literal('tool_result'), tools: z.array(tool).max(8).default([]),
    outcome: z.enum(['any', 'returned', 'failed', 'cancelled']).default('any'),
    error_codes: z.array(text(160)).max(8).default([]),
  }).strict().refine(value => value.tools.length || value.error_codes.length || value.outcome !== 'any',
    'A result trigger needs tools, an outcome or error codes.'),
]);

/** Examples are teaching material, never an executable call or a live observation. */
export const usageNodeSchema = z.object({
  id, name: text(120), instruction: text(3000),
  when: z.array(trigger).max(6).default([]), priority: z.number().int().min(0).max(10).default(0),
  capabilities: z.array(z.object({ tool, purpose: text(300) }).strict()).max(6).default([]),
  recommendations: z.array(id).max(6).default([]),
  recipes: z.array(id).max(6).default([]),
  adaptation: z.array(text(500)).max(8).default([]),
  checks: z.array(text(500)).max(8).default([]),
  decisions: z.array(decision).max(3).default([]),
  examples: z.array(z.object({
    situation: text(800),
    steps: z.array(z.object({
      tool: tool.optional(), arguments: z.record(z.string(), z.json()).optional(), observation: text(800),
    }).strict().refine(value => value.arguments === undefined || value.tool !== undefined,
      'Example arguments need a tool name.')).min(1).max(6),
    lesson: text(800), source: text(1000).optional(),
    assessments: z.array(assessment).max(6).default([]),
    comparison: z.object({ before: id, after: id, held_constant: text(600), changed: text(600) }).strict()
      .refine(value => value.before !== value.after, 'Compare two distinct evidence references.').optional(),
  }).strict()).max(2).default([]),
}).strict().refine(value => JSON.stringify(value).length <= 6000,
  'Keep each usage node within 6000 characters; split unrelated lessons.');

export const usageDefinitionSchema = z.object({
  protocol: z.literal(USAGE_PROTOCOL), id, name: text(120), objective: text(1000), entry_node: id,
  plan: z.array(id).max(20).default([]).describe('Ordered default plan referencing teaching node IDs. Reuse or adapt it through CardBush update_task_plan; all live progress stays in that native plan. Empty only for legacy packs.'),
  constraints: z.array(z.object({ source: text(1000), text: text(2000) }).strict()).max(8).default([]),
  criteria: z.array(usageCriterionSchema).max(8).default([]),
  evidence: z.array(usageEvidenceSchema).max(24).default([]),
  capabilities: z.array(usageCapabilitySchema).max(8).default([]),
  recipes: z.array(usageRecipeSchema).max(6).default([]),
  nodes: z.array(usageNodeSchema).min(1).max(24),
}).strict().superRefine((value, context) => {
  const ids = new Set(value.nodes.map(node => node.id));
  if (ids.size !== value.nodes.length || !ids.has(value.entry_node)) context.addIssue({ code: 'custom', message: 'Node IDs must be unique and include entry_node.' });
  if (new Set(value.plan).size !== value.plan.length || value.plan.some(key => !ids.has(key))) context.addIssue({ code: 'custom', path: ['plan'], message: 'Default plan IDs must be unique and reference existing teaching nodes.' });
  if (JSON.stringify(value.constraints).length > 3000) context.addIssue({ code: 'custom', message: 'Keep shared source constraints within 3000 characters.' });
  if (JSON.stringify(value.criteria).length > 5000) context.addIssue({ code: 'custom', message: 'Keep shared quality criteria within 5000 characters.' });
  if (JSON.stringify(value.evidence).length > 16000) context.addIssue({ code: 'custom', message: 'Keep evidence locators within 16000 characters; link to assets instead of embedding them.' });
  if (JSON.stringify(value.capabilities).length > 4000) context.addIssue({ code: 'custom', message: 'Keep capability recommendations within 4000 characters.' });
  const criteria = new Set(value.criteria.map(item => item.id)), evidence = new Set(value.evidence.map(item => item.id));
  const capabilities = new Set(value.capabilities.map(item => item.id)), recipes = new Set(value.recipes.map(item => item.id));
  if (capabilities.size !== value.capabilities.length || recipes.size !== value.recipes.length) context.addIssue({ code: 'custom', message: 'Capability and method IDs must be unique.' });
  if (criteria.size !== value.criteria.length || evidence.size !== value.evidence.length) context.addIssue({ code: 'custom', message: 'Criterion and evidence IDs must be unique within their collection.' });
  const reference = (key: string, collection: Set<string>, path: Array<string | number>) => {
    if (!collection.has(key)) context.addIssue({ code: 'custom', path, message: `Unknown teaching reference: ${key}` });
  };
  value.nodes.forEach((node, n) => {
    node.recommendations.forEach((key, k) => reference(key, capabilities, ['nodes', n, 'recommendations', k]));
    node.recipes.forEach((key, k) => reference(key, recipes, ['nodes', n, 'recipes', k]));
    node.when.forEach((rule, r) => { if (rule.on === 'recipe_result') rule.recipes.forEach((key, k) => reference(key, recipes, ['nodes', n, 'when', r, 'recipes', k])); });
    node.decisions.forEach((item, d) => item.criteria.forEach((key, k) => reference(key, criteria, ['nodes', n, 'decisions', d, 'criteria', k])));
    node.examples.forEach((example, e) => {
      example.assessments.forEach((item, a) => {
        reference(item.criterion, criteria, ['nodes', n, 'examples', e, 'assessments', a, 'criterion']);
        item.evidence_ids.forEach((key, k) => reference(key, evidence, ['nodes', n, 'examples', e, 'assessments', a, 'evidence_ids', k]));
      });
      if (example.comparison) for (const field of ['before', 'after'] as const) reference(example.comparison[field], evidence, ['nodes', n, 'examples', e, 'comparison', field]);
    });
  });
  value.recipes.forEach((recipe, r) => recipe.requires.forEach((key, k) => {
    reference(key, capabilities, ['recipes', r, 'requires', k]);
    if (value.capabilities.find(item => item.id === key)?.kind === 'skill') context.addIssue({ code: 'custom', path: ['recipes', r, 'requires', k], message: 'Skills are guidance to read, not callable method dependencies. Recommend them on the node.' });
  }));
  if (JSON.stringify(value).length > 160000) context.addIssue({ code: 'custom', message: 'Keep a usage pack within 160000 characters.' });
});
export type UsageDefinition = z.infer<typeof usageDefinitionSchema>;
export type UsageNode = z.infer<typeof usageNodeSchema>;

const revision = z.number().int().nonnegative();
export const usageInputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('guide') }).strict(),
  z.object({ action: z.literal('recommend'), capability_id: id }).strict(),
  z.object({ action: z.literal('recipe'), recipe_id: id }).strict(),
  z.object({ action: z.literal('capture'), turn_id: text(1000).optional(), tool_call_ids: z.array(text(1000)).min(1).max(8).optional(),
    limit: z.number().int().min(1).max(8).default(6) }).strict(),
  z.object({ action: z.literal('review'), usage: z.unknown().optional() }).strict(),
  z.object({ action: z.literal('import'), expected_revision: revision, usage: usageDefinitionSchema,
    enabled: z.boolean().default(true), asset_root: assetRoot.optional() }).strict(),
  z.object({ action: z.literal('status') }).strict(),
  z.object({ action: z.literal('export') }).strict(),
  z.object({ action: z.literal('enable'), expected_revision: revision }).strict(),
  z.object({ action: z.literal('disable'), expected_revision: revision }).strict(),
  z.object({ action: z.literal('focus'), expected_revision: revision, node_id: id.nullable() }).strict(),
]);
export type UsageInput = z.infer<typeof usageInputSchema>;

export const usageRecipeInvocationSchema = z.object({
  recipe_id: id, expected_revision: revision,
  parameters: z.record(z.string(), z.json()).default({}),
  bindings: z.record(id, tool).default({}).describe('Local capability ID -> tool selected from the current environment. These implementation names are call-time bindings, never portable teaching requirements.'),
}).strict().refine(value => JSON.stringify(value).length <= 32000, 'Keep method inputs and bindings within 32000 characters.');
export type UsageRecipeInvocation = z.infer<typeof usageRecipeInvocationSchema>;
export const usageRecipeIdentitySchema = z.object({ usage_id: id, recipe_id: id, definition_sha256: digest }).strict();
export type UsageRecipeIdentity = z.infer<typeof usageRecipeIdentitySchema>;

export const usageSessionSchema = z.object({
  id: text(1000), usage: usageDefinitionSchema, enabled: z.boolean(), focus: id.nullable(),
  plan_revision_at_load: revision.default(0),
  plugin: z.object({ command_id: text(240), definition_sha256: digest, guard_hashes: z.array(digest).max(100).default([]) }).strict().optional(),
  asset_root: assetRoot.nullable().default(null),
  activated_after: z.object({ turnId: text(1000), toolCallId: text(1000) }).strict(),
}).strict().refine(value => value.focus === null || value.usage.nodes.some(node => node.id === value.focus),
  'The focused node must belong to this usage pack.');
export type UsageSession = z.infer<typeof usageSessionSchema>;
