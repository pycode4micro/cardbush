import { randomUUID } from "node:crypto";
import { readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import {
  BUSH_EXECUTION_FACT_PROTOCOL,
  BUSH_TOOL_RESULT_PROTOCOL,
  type ToolResult,
} from "@cardbush/bush-protocol";

import type { ToolHandlerContext, ToolRegistration, ToolRegistry } from "./toolRegistry.js";

interface SkillCard {
  name: string;
  description: string;
  descriptionZh: string;
  packageDir: string;
}

export function registerSkillTools(registry: ToolRegistry, roots: string[]): void {
  const normalizedRoots = [...new Set(roots.map((root) => resolve(root)).filter(isAbsolute))];
  registry.register(searchRegistration(normalizedRoots));
  registry.register(readRegistration(normalizedRoots));
}

function searchRegistration(roots: string[]): ToolRegistration<{ query: string; limit: number }> {
  return {
    definition: {
      name: "search_skills",
      description: "Search the installed Skill catalog by natural-language capability description. Returns factual Skill cards; choosing whether to use one remains the model's decision.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1 },
          limit: { type: "integer", minimum: 1, maximum: 20, default: 8 },
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
      const limit = Math.min(20, Math.max(1, Number(input.limit) || 8));
      if (!query) throw new Error("query is required.");
      return { query, limit };
    },
    execute: async (context) => {
      const terms = tokens(context.input.query);
      const skills = await loadCards(roots);
      const matches = skills
        .map((skill) => ({ ...skill, score: score(skill, terms) }))
        .filter((skill) => skill.score > 0)
        .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
        .slice(0, context.input.limit);
      return success(context, { query: context.input.query, matches }, matches.map((item) => item.packageDir));
    },
  };
}

function readRegistration(roots: string[]): ToolRegistration<{ name: string; resource: string }> {
  return {
    definition: {
      name: "read_skill",
      description: "Read an installed Skill instruction file or one referenced resource. Omit resource to read SKILL.md; use relative resource paths returned or referenced by the Skill.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1 },
          resource: { type: "string", default: "SKILL.md" },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
    manifest: manifest("skills.read"),
    parallelSafe: true,
    visibleToChild: true,
    decodeInput: (value) => {
      const input = object(value);
      const name = String(input.name ?? "").trim();
      const resource = String(input.resource ?? "SKILL.md").trim() || "SKILL.md";
      if (!name) throw new Error("name is required.");
      if (isAbsolute(resource)) throw new Error("resource must be relative to the Skill package.");
      return { name, resource };
    },
    execute: async (context) => {
      const skill = (await loadCards(roots)).find((item) => item.name === context.input.name);
      if (!skill) throw new Error(`Skill ${context.input.name} is not installed.`);
      const packageDir = await realpath(skill.packageDir);
      const target = await realpath(join(packageDir, context.input.resource));
      const escaped = relative(packageDir, target);
      if (escaped.startsWith("..") || isAbsolute(escaped)) {
        throw new Error("Skill resource escapes its package directory.");
      }
      return success(context, {
        name: skill.name,
        resource: context.input.resource,
        path: target,
        content: await readFile(target, "utf8"),
      }, [target]);
    },
  };
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
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const packageDir = join(root, entry.name);
      let content;
      try {
        content = await readFile(join(packageDir, "SKILL.md"), "utf8");
      } catch {
        continue;
      }
      const frontmatter = parseFrontmatter(content);
      const name = frontmatter.name || entry.name;
      byName.set(name, {
        name,
        description: frontmatter.description || "",
        descriptionZh: frontmatter.description_zh || "",
        packageDir,
      });
    }
  }
  return [...byName.values()];
}

function parseFrontmatter(content: string): Record<string, string> {
  if (!content.startsWith("---")) return {};
  const end = content.indexOf("\n---", 3);
  if (end < 0) return {};
  const result: Record<string, string> = {};
  for (const line of content.slice(3, end).split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!match) continue;
    result[match[1]] = unquote(match[2].trim());
  }
  return result;
}

function score(skill: SkillCard, terms: string[]): number {
  if (terms.length === 0) return 0;
  const name = normalize(skill.name);
  const description = normalize(`${skill.description} ${skill.descriptionZh}`);
  return terms.reduce((total, term) =>
    total + (name === term ? 4 : name.includes(term) ? 2 : description.includes(term) ? 1 : 0), 0);
}

function tokens(value: string) {
  return [...new Set(normalize(value).split(/[^\p{L}\p{N}_]+/u).filter(Boolean))];
}

function normalize(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase();
}

function unquote(value: string) {
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1).replace(/\\"/g, '"');
  }
  return value;
}

function manifest(operation: string) {
  return {
    effect_kind: "observation",
    operation,
    risk: "low",
    owner: "runtime",
    dispatch_phase: "execution",
    dispatch_scope: "runtime",
    dispatch_side_effect: "none",
    dispatch_mutating: false,
    dispatch_source: "product_skill_snapshot",
    stage_modes: ["read"],
    output_kinds: ["skill_instruction"],
    handoff_exports: [],
    evidence_hints: ["skill_resource"],
  };
}

function success(
  context: ToolHandlerContext<unknown>,
  output: unknown,
  paths: string[],
): ToolResult {
  return {
    protocol: BUSH_TOOL_RESULT_PROTOCOL,
    tool_call_id: context.toolCall.id,
    success: true,
    output,
    facts: [{
      protocol: BUSH_EXECUTION_FACT_PROTOCOL,
      receipt_id: `receipt_${randomUUID()}`,
      action_manifest_id: context.actionManifest.manifest_id,
      status: "completed",
      operation: context.actionManifest.operation,
      effect_kind: context.actionManifest.effect_kind,
      owner: context.actionManifest.owner,
      dispatch_scope: context.actionManifest.dispatch_scope,
      categories: ["skill"],
      paths,
      execution_success: true,
      semantic_success: true,
      verification_state: "verified",
      error_code: "",
    }],
    artifacts: [],
    workspace_changes: [],
    guidance: [],
  };
}

function object(value: unknown): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Tool arguments must be an object.");
  }
  return value as Record<string, unknown>;
}
