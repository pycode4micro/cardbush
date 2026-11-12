import { rankPluginText } from './pluginTextSearch.js';
import { configurePluginSearch, type PluginSearchSources } from './pluginSearch.js';
import { readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { searchLimitParameter, searchResultLimitSchema } from '@cardbush/bush-protocol';
import { readPluginSkill, skillPluginIdentity } from './pluginSkills.js';
import { resolveSearchResultLimit, type SearchResultLimitProvider } from './searchResultLimit.js';
import { catalogPage, catalogPageProperties, discoveryDescription, projectCatalogPage } from './catalogPage.js';

import type { ToolAdmissionContext, ToolRegistration, ToolRegistry } from "./toolRegistry.js";
import { isWithin, normalizeIdentity } from './workspaceAccessPolicy.js';

interface SkillCard {
  name: string;
  description: string;
  descriptionZh: string;
  packageDir: string;
  mainResource: string;
  invocation?: string;
  unqualifiedName?: string;
}

export type SkillRootProvider = () => string[] | Promise<string[]>;
const resourceProviders = new WeakMap<ToolRegistry, SkillRootProvider>();

function visibleSkills(skills: SkillCard[], context: Pick<ToolAdmissionContext, 'turn'>) {
  const metadata = context.turn?.request.metadata;
  const allowed = Array.isArray(metadata?.allowedSkills) ? new Set(metadata.allowedSkills) : undefined;
  const disabled = new Set(Array.isArray(metadata?.disabledSkills) ? metadata.disabledSkills : []);
  return skills.filter(skill => (allowed === undefined || allowed.has(skill.name) || allowed.has(skill.unqualifiedName!))
    && !disabled.has(skill.name) && !disabled.has(skill.unqualifiedName!));
}

/** Only registered, currently visible instructions and references are resources.
 * This never grants scripts, sibling files, writes, or terminal directory access. */
export async function isSkillReadResource(registry: ToolRegistry, context: ToolAdmissionContext, path: string) {
  const provider = resourceProviders.get(registry);
  if (!provider) return false;
  for (const skill of visibleSkills(await loadCards(await provider()), context)) {
    try {
      const root = await realpath(skill.packageDir), main = await realpath(skill.mainResource);
      if (!isWithin(root, main)) continue;
      if (normalizeIdentity(path) === normalizeIdentity(main) || isWithin(join(root, 'references'), path)) return true;
    } catch { /* Missing or replaced resources retain normal path admission. */ }
  }
  return false;
}

export function registerSkillTools(
  registry: ToolRegistry,
  roots: string[] | SkillRootProvider,
  loadSearchResultLimit?: SearchResultLimitProvider,
): void {
  const provider = typeof roots === "function"
    ? async () => normalizeRoots(await roots())
    : async () => normalizeRoots(roots);
  resourceProviders.set(registry, provider);
  const search: NonNullable<PluginSearchSources['skills']> = async (context, query) => {
    const activeRoots = await provider();
    const rank = rankPluginText(query);
    const skills = visibleSkills(await loadCards(activeRoots), context);
    return skills
      .map((skill) => ({ ...skill, score: rank(skill.name, skill.description + ' ' + skill.descriptionZh) }))
      .filter((skill) => skill.score > 0)
      .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
      .map(skill => ({ score: skill.score, card: {
        kind: 'skill' as const,
        name: skill.name,
        description: discoveryDescription(skill.description),
        ...(discoveryDescription(skill.description) !== skill.description ? { descriptionTruncated: true } : {}),
        mainResource: skill.mainResource,
        environment: 'local',
        ...(skill.invocation ? { invocation: skill.invocation } : {}),
      } }));
  };
  configurePluginSearch(registry, { skills: search, loadSearchResultLimit });
  registry.register(searchRegistration(search, loadSearchResultLimit));
}

function searchRegistration(
  search: NonNullable<PluginSearchSources['skills']>,
  loadSearchResultLimit?: SearchResultLimitProvider,
): ToolRegistration<{ query: string; limit?: number; offset: number }> {
  return {
    supersededBy: 'search_plugins',
    definition: {
      name: "search_skills",
      description: "Search installed Skills by capability or name; query='*' lists all visible Skills. total counts matches for this query, not all installed Skills. Returns brief descriptions, next_offset, mainResource (SKILL.md), environment=local and an invocation id for plugin Skills. Continue with next_offset as offset and the same query. Read the selected file with read_file in that environment, even in an SSH workspace; local means this Runtime host. Inspect its references/ directory when present and read relevant documents even if unlinked, resolving paths relative to the Skill directory. Reuse resources already in context. To invoke a plugin Skill, pass its exact id to run_skill; other Skills are applied by reading their files.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1, description: "Capability keywords or '*': list all Skills visible in the current scope." },
          limit: { ...searchLimitParameter },
          offset: catalogPageProperties.offset,
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    manifest: manifest("skills.search"),
    parallelSafe: true,
    visibleToChild: true,
    projectModelPage: (value, budget) => projectCatalogPage(value, budget, ['matches']),
    decodeInput: (value) => {
      const input = object(value);
      const query = String(input.query ?? "").trim();
      const limit = searchResultLimitSchema.optional().parse(input.limit);
      if (!query) throw new Error("query is required.");
      if (input.offset !== undefined && (!Number.isSafeInteger(input.offset) || Number(input.offset) < 0)) throw new Error('offset must be a nonnegative integer.');
      return { query, limit, offset: Number(input.offset ?? 0) };
    },
    execute: async (context) => {
      const limit = await resolveSearchResultLimit(context.input.limit, loadSearchResultLimit);
      const matches = (await search(context, context.input.query)).map(({ card: { kind, ...card } }) => card);
      const { items, ...page } = catalogPage(matches, { offset: context.input.offset, limit });
      return { matches: items, ...page };
    },
  };
}

function normalizeRoots(roots: string[]): string[] {
  return [...new Set(roots.map((root) => resolve(root)).filter(isAbsolute))];
}

async function loadCards(roots: string[]): Promise<SkillCard[]> {
  const byName = new Map<string, SkillCard>();
  for (const root of roots) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    const directories = entries.some(entry => entry.isFile() && entry.name === 'SKILL.md') ? [root]
      : entries.filter(entry => entry.isDirectory()).map(entry => join(root, entry.name));
    for (const packageDir of directories) {
      let parsed, plugin;
      try {
        plugin = await skillPluginIdentity(join(packageDir, 'SKILL.md'));
        parsed = await readPluginSkill(join(packageDir, 'SKILL.md'), plugin?.id, plugin?.root);
      } catch {
        continue;
      }
      if (parsed.command.disableModelInvocation || parsed.issues.length) continue;
      const name = parsed.command.id;
      byName.set(name, {
        name,
        description: parsed.command.description,
        descriptionZh: String(parsed.metadata.description_zh || ''),
        unqualifiedName: parsed.command.name,
        ...(plugin ? { invocation: parsed.command.id } : {}),
        packageDir,
        mainResource: join(packageDir, "SKILL.md"),
      });
    }
  }
  return [...byName.values()];
}


function manifest(operation: string) {
  return {
    effect_kind: "observation",
    operation,
    risk: "low",
    owner: "runtime",
    dispatch_scope: "runtime",
    mutating: false,
  };
}

function object(value: unknown): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Tool arguments must be an object.");
  }
  return value as Record<string, unknown>;
}
