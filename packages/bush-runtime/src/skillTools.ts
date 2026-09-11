import { readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { searchLimitParameter, searchResultLimitSchema } from '@cardbush/bush-protocol';
import { readPluginSkill, skillPluginIdentity } from './pluginSkills.js';
import { resolveSearchResultLimit, type SearchResultLimitProvider } from './searchResultLimit.js';

import type { ToolRegistration, ToolRegistry } from "./toolRegistry.js";

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

export function registerSkillTools(
  registry: ToolRegistry,
  roots: string[] | SkillRootProvider,
  loadSearchResultLimit?: SearchResultLimitProvider,
): void {
  const provider = typeof roots === "function"
    ? async () => normalizeRoots(await roots())
    : async () => normalizeRoots(roots);
  registry.register(searchRegistration(provider, loadSearchResultLimit));
}

function searchRegistration(
  roots: SkillRootProvider,
  loadSearchResultLimit?: SearchResultLimitProvider,
): ToolRegistration<{ query: string; limit?: number }> {
  return {
    definition: {
      name: "search_skills",
      description: "Search installed Skills by capability. Returns names, short descriptions and local SKILL.md paths in mainResource. Read the selected file with read_file for full instructions. Plugin Skills also include an invocation id: use run_skill with that id to apply policies, parameters and dependencies; reading the file alone does not invoke them.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1 },
          limit: { ...searchLimitParameter },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    manifest: manifest("skills.search"),
    parallelSafe: true,
    visibleToChild: true,
    decodeInput: (value) => {
      const input = object(value);
      const query = String(input.query ?? "").trim();
      const limit = searchResultLimitSchema.optional().parse(input.limit);
      if (!query) throw new Error("query is required.");
      return { query, limit };
    },
    execute: async (context) => {
      const limit = await resolveSearchResultLimit(context.input.limit, loadSearchResultLimit);
      const activeRoots = await roots();
      const terms = tokens(context.input.query);
      const configured = context.turn?.request.metadata.allowedSkills;
      const allowed = Array.isArray(configured)
        ? new Set(configured.filter((item): item is string => typeof item === "string"))
        : undefined;
      const disabled = new Set(Array.isArray(context.turn?.request.metadata.disabledSkills)
        ? context.turn.request.metadata.disabledSkills : []);
      const skills = (await loadCards(activeRoots)).filter((skill) =>
        (allowed === undefined || allowed.has(skill.name) || allowed.has(skill.unqualifiedName!)) && !disabled.has(skill.name) && !disabled.has(skill.unqualifiedName!),
      );
      const matches = skills
        .map((skill) => ({ ...skill, score: score(skill, terms) }))
        .filter((skill) => skill.score > 0)
        .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
        .slice(0, limit)
        .map(skill => ({
          name: skill.name,
          description: skill.description.slice(0, 512),
          ...(skill.description.length > 512 ? { descriptionTruncated: true } : {}),
          mainResource: skill.mainResource,
          ...(skill.invocation ? { invocation: skill.invocation } : {}),
        }));
      return { matches };
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


function score(skill: SkillCard, terms: string[]): number {
  if (terms.length === 0) return 0;
  const name = normalize(skill.name);
  const description = normalize(`${skill.description} ${skill.descriptionZh}`);
  return terms.reduce((total, term) =>
    total + (name === term ? 4 : name.includes(term) ? 2 : description.includes(term) ? 1 : 0), 0);
}

const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

function tokens(value: string) {
  // Whitespace splitting treats a Chinese request as one unmatchable term. Keep
  // identifiers intact, but segment unspaced text. ICU can split unknown terms
  // such as 插件 into single characters; pairs preserve recall without matching
  // every description on a particle such as 的.
  return [...new Set(normalize(value).split(/[^\p{L}\p{N}_]+/u).flatMap((part) =>
    /\p{Script=Han}/u.test(part)
      ? segmentHanText(part)
      : part ? [part] : [],
  ))];
}

function segmentHanText(value: string): string[] {
  const result = [...value].length > 1 ? [value] : [];
  let previousHan = "";
  for (const item of wordSegmenter.segment(value)) {
    if (/^\p{Script=Han}$/u.test(item.segment)) {
      if (previousHan) result.push(previousHan + item.segment);
      previousHan = item.segment;
    } else {
      previousHan = "";
      if (item.isWordLike) result.push(item.segment);
    }
  }
  return result;
}

function normalize(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase();
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
