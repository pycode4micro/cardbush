import { randomUUID, createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import {
  BUSH_EXECUTION_FACT_PROTOCOL,
  BUSH_TOOL_RESULT_PROTOCOL,
  type ToolResult,
} from "@cardbush/bush-protocol";

import type { ToolAdmissionContext, ToolHandlerContext, ToolRegistry } from "./toolRegistry.js";

export interface ExtendedBuiltinOptions {
  dataRoot?: string;
  skillRoots?: string[];
  readToolResult?: (locator: string) => unknown;
}

export function registerExtendedBuiltins(registry: ToolRegistry, options: ExtendedBuiltinOptions = {}): void {
  const dataRoot = resolve(options.dataRoot || join(process.cwd(), ".cardbush-runtime"));
  registerLogic(registry, dataRoot);
  registerKed(registry, dataRoot, options.readToolResult);
  registerImageInput(registry);
  registerSchedule(registry, dataRoot);
  registerSkillsManager(registry, options.skillRoots ?? []);
  registerCad(registry);
  registerParallel(registry);
}

function registerLogic(registry: ToolRegistry, dataRoot: string) {
  const store = new JsonStore(join(dataRoot, "memory", "logic.json"));
  registry.register<Record<string, unknown>>({
    definition: { name: "consult_logic", description: "Consult local reasoning memory before strong judgments, evidence conflicts, complex tradeoffs, delegation, or completion decisions. Advisory memories are not task facts.", inputSchema: objectSchema(["query"], { query: { type: "string" }, max_results: { type: "integer", minimum: 1, maximum: 10 } }) },
    manifest: manifest("logic.consult", false, "session"), parallelSafe: true,
    decodeInput: object,
    execute: async (context) => {
      const query = requiredText(context.input.query, "query");
      const terms = tokens(query);
      const records = await store.read();
      const matches = records.map((item) => ({ ...item, score: score(item, terms) }))
        .filter((item) => item.score > 0).sort((a, b) => b.score - a.score)
        .slice(0, clamp(context.input.max_results, 1, 10, 5));
      return success(context, { query, matches }, [], ["logic"]);
    },
  });
  registry.register<Record<string, unknown>>({
    definition: { name: "learn_logic", description: "Store a local reasoning lesson as scenario-bias-correction memory, or record feedback for an existing logic_id. Store how to reason, not task instructions.", inputSchema: { type: "object", additionalProperties: true } },
    manifest: manifest("logic.learn", true, "session"), visibleToChild: false,
    decodeInput: object,
    execute: async (context) => {
      const records = await store.read();
      const logicId = text(context.input.logic_id) || `logic_${randomUUID()}`;
      const existing = records.findIndex((item) => item.logic_id === logicId);
      const hasReward = context.input.reward !== undefined && context.input.reward !== null && context.input.reward !== "";
      const reward = hasReward ? Number(context.input.reward) : undefined;
      const entry = { logic_id: logicId, scenario: text(context.input.scenario), bias: text(context.input.bias), correction: text(context.input.correction), lesson: text(context.input.lesson), ...(reward !== undefined ? { reward } : {}), updated_at: new Date().toISOString() };
      if (!entry.lesson && !entry.correction && reward === undefined) throw new Error("lesson, correction, or reward is required.");
      if (reward !== undefined && !Number.isFinite(reward)) throw new Error("reward must be a finite number.");
      if (existing >= 0) records[existing] = { ...records[existing], ...entry };
      else records.push(entry);
      await store.write(records);
      return success(context, entry, [store.path], ["logic"]);
    },
  });
}

function registerKed(
  registry: ToolRegistry,
  dataRoot: string,
  readToolResult?: (locator: string) => unknown,
) {
  const store = new JsonStore(join(dataRoot, "ked", "knowledge.json"));
  registry.register<Record<string, unknown>>({
    definition: { name: "ked_knowledge", description: "Ingest, search, read, list, and delete reusable local knowledge with traceable item identifiers.", inputSchema: { type: "object", additionalProperties: true } },
    manifest: manifest("knowledge.manage", true, "session"),
    decodeInput: object,
    authorize: async (context) => text(context.input.action) === "ingest_file"
      ? pathAdmission(context, requiredText(context.input.path, "path"), "read")
      : { kind: "allow" },
    execute: async (context) => {
      const action = text(context.input.action) || "search";
      const records = await store.read();
      if (action === "ingest_text" || action === "ingest_file") {
        const sourcePath = action === "ingest_file" ? requiredText(context.input.path, "path") : "";
        const content = action === "ingest_file" ? await readFile(resolve(sourcePath), "utf8") : requiredText(context.input.content, "content");
        const itemId = text(context.input.item_id) || `ked_${createHash("sha256").update(content).digest("hex").slice(0, 20)}`;
        const item = { item_id: itemId, domain: text(context.input.domain), title: text(context.input.title) || basename(sourcePath) || itemId, source: text(context.input.source) || sourcePath, tags: stringList(context.input.tags), content, updated_at: new Date().toISOString() };
        const index = records.findIndex((entry) => entry.item_id === itemId);
        if (index >= 0) records[index] = item; else records.push(item);
        await store.write(records);
        return success(context, { status: "ingested", item_id: itemId, char_count: content.length }, [store.path, ...(sourcePath ? [resolve(sourcePath)] : [])], ["knowledge"]);
      }
      if (action === "delete") {
        const itemId = requiredText(context.input.item_id, "item_id");
        const next = records.filter((item) => item.item_id !== itemId);
        await store.write(next);
        return success(context, { status: next.length === records.length ? "not_found" : "deleted", item_id: itemId }, [store.path], ["knowledge"]);
      }
      if (action === "read") {
        const itemId = requiredText(context.input.item_id, "item_id");
        const item = records.find((entry) => entry.item_id === itemId);
        return success(context, item ?? { status: "not_found", item_id: itemId }, [store.path], ["knowledge"]);
      }
      if (action === "list") return success(context, records.slice(0, clamp(context.input.limit, 1, 200, 50)).map(summary), [store.path], ["knowledge"]);
      const query = requiredText(context.input.query, "query");
      const terms = tokens(query);
      const matches = records.map((item) => ({ ...summary(item), score: score(item, terms), snippet: text(item.content).slice(0, clamp(context.input.max_chars_per_result, 120, 4000, 900)) }))
        .filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, clamp(context.input.top_k, 1, 30, 8));
      return success(context, { query, matches }, [store.path], ["knowledge"]);
    },
  });
  registry.register<Record<string, unknown>>({
    definition: { name: "ked_read_temp_object", description: "Read exact excerpts from a KED temporary object or an archived Tool result using its stable locator.", inputSchema: { type: "object", additionalProperties: false, properties: { locator: { type: "string" }, temp_id: { type: "string" }, query: { type: "string" }, line_start: { type: "integer" }, line_end: { type: "integer" }, context_lines: { type: "integer" }, offset: { type: "integer", minimum: 0 }, max_chars: { type: "integer" } } } },
    manifest: manifest("knowledge.temp.read", false, "session"), parallelSafe: true,
    decodeInput: object,
    execute: async (context) => {
      const locator = text(context.input.locator);
      if (locator.startsWith("tool-result://")) {
        if (!readToolResult) throw new Error("Archived Tool result lookup is unavailable.");
        const serialized = JSON.stringify(readToolResult(locator));
        const offset = clamp(context.input.offset, 0, serialized.length, 0);
        const maxChars = clamp(context.input.max_chars, 500, 50_000, 12_000);
        return success(context, {
          locator,
          offset,
          next_offset: Math.min(serialized.length, offset + maxChars),
          complete: offset + maxChars >= serialized.length,
          text: serialized.slice(offset, offset + maxChars),
        }, [], ["tool_result_archive"]);
      }
      const id = (locator || text(context.input.temp_id)).replace(/^ked-temp:\/\//, "");
      if (!/^[a-fA-F0-9]{16,64}$/.test(id)) throw new Error("A valid ked-temp:// locator is required.");
      const path = join(dataRoot, "ked", "temp", id, "content.txt");
      const content = await readFile(path, "utf8");
      const lines = content.split(/\r?\n/);
      const query = text(context.input.query).toLocaleLowerCase();
      const start = query ? Math.max(0, lines.findIndex((line) => line.toLocaleLowerCase().includes(query))) : Math.max(0, Number(context.input.line_start ?? 1) - 1);
      const contextLines = clamp(context.input.context_lines, 0, 50, 3);
      const from = Math.max(0, start - contextLines);
      const to = Math.min(lines.length, Number(context.input.line_end ?? start + contextLines + 1) + contextLines);
      return success(context, { locator: `ked-temp://${id}`, line_start: from + 1, line_end: to, text: lines.slice(from, to).join("\n").slice(0, clamp(context.input.max_chars, 500, 50000, 12000)) }, [path], ["knowledge"]);
    },
  });
}

function registerImageInput(registry: ToolRegistry) {
  registry.register<Record<string, unknown>>({
    definition: { name: "inject_image_input", description: "Queue a validated local image path, http(s) URL, or data image as standard image input for the next model round.", inputSchema: objectSchema(["url"], { url: { type: "string" }, label: { type: "string" }, caption: { type: "string" }, detail: { enum: ["auto", "low", "high"] } }) },
    manifest: manifest("image.inject", false, "session"), parallelSafe: false,
    decodeInput: object,
    authorize: async (context) => {
      const url = requiredText(context.input.url, "url");
      return isAbsolute(url) ? pathAdmission(context, url, "read") : { kind: "allow" };
    },
    execute: async (context) => {
      const url = requiredText(context.input.url, "url");
      if (!isAbsolute(url) && !/^https?:\/\//i.test(url) && !/^data:image\//i.test(url)) throw new Error("url must be an absolute path, http(s) URL, or data image.");
      if (isAbsolute(url)) await stat(url);
      return success(context, { queued: true, url, label: text(context.input.label), caption: text(context.input.caption) }, isAbsolute(url) ? [url] : [], ["image_input"], [{ artifact_id: `image_${randomUUID()}`, type: "image", ...(isAbsolute(url) ? { path: url } : { uri: url }), display: "inline", metadata: { model_input: true, detail: text(context.input.detail) || "auto" } }]);
    },
  });
}

function registerSchedule(registry: ToolRegistry, dataRoot: string) {
  const store = new JsonStore(join(dataRoot, "scheduler", "jobs.json"));
  registry.register<Record<string, unknown>>({
    definition: { name: "schedule_task", description: "Create, list, or cancel delayed delivery records for already prepared text or files. This does not run open-ended background work.", inputSchema: { type: "object", additionalProperties: true } },
    manifest: manifest("schedule.manage", true, "session"), visibleToChild: false,
    decodeInput: object,
    execute: async (context) => {
      const action = text(context.input.action) || "create";
      const jobs = await store.read();
      if (action === "list") return success(context, { jobs }, [store.path], ["scheduled_delivery"]);
      if (action === "cancel") {
        const id = requiredText(context.input.job_id, "job_id");
        const job = jobs.find((item) => item.job_id === id);
        if (job) { job.status = "cancelled"; job.updated_at = new Date().toISOString(); await store.write(jobs); }
        return success(context, job ?? { status: "not_found", job_id: id }, [store.path], ["scheduled_delivery"]);
      }
      const dueAt = requiredText(context.input.due_at ?? context.input.run_at, "due_at");
      if (!Number.isFinite(Date.parse(dueAt))) throw new Error("due_at must be an ISO date-time.");
      const job = { job_id: `schedule_${randomUUID()}`, status: "scheduled", due_at: new Date(dueAt).toISOString(), text: text(context.input.text), deliverables: Array.isArray(context.input.deliverables) ? context.input.deliverables : [], created_at: new Date().toISOString(), execution: "external_scheduler_required" };
      jobs.push(job); await store.write(jobs);
      return success(context, job, [store.path], ["scheduled_delivery"]);
    },
  });
}

function registerSkillsManager(registry: ToolRegistry, roots: string[]) {
  registry.register<Record<string, unknown>>({
    definition: { name: "skills_manager", description: "Inspect or administratively install/uninstall local Skill knowledge packages. Skills cannot grant executable tools.", inputSchema: { type: "object", additionalProperties: true } },
    manifest: manifest("skills.manage", true, "skill"), visibleToChild: false,
    decodeInput: object,
    authorize: async (context) => {
      const action = text(context.input.action) || "user_ask_list";
      if (action === "user_ask_list") return { kind: "allow" };
      if (action === "check") return pathAdmission(context, requiredText(context.input.source_path, "source_path"), "read");
      const targetRoot = roots[0];
      if (!targetRoot) return { kind: "allow" };
      if (action === "uninstall") return pathAdmission(context, join(targetRoot, safeName(requiredText(context.input.name, "name"))), "write");
      return combineAdmissions([
        await pathAdmission(context, requiredText(context.input.source_path, "source_path"), "read"),
        await pathAdmission(context, targetRoot, "write"),
      ]);
    },
    execute: async (context) => {
      const action = text(context.input.action) || "user_ask_list";
      if (action === "user_ask_list") return success(context, { roots, skills: await listSkills(roots) }, roots, ["skill"]);
      if (action === "check") {
        const source = resolve(requiredText(context.input.source_path, "source_path"));
        return success(context, { valid: Boolean(await readFile(join(source, "SKILL.md"), "utf8")), source_path: source }, [source], ["skill"]);
      }
      const targetRoot = roots[0];
      if (!targetRoot) throw new Error("No writable Skill root is configured.");
      if (action === "uninstall") {
        const name = safeName(requiredText(context.input.name, "name"));
        const target = join(targetRoot, name); await rm(target, { recursive: true, force: true });
        return success(context, { status: "uninstalled", name }, [target], ["skill"]);
      }
      const source = resolve(requiredText(context.input.source_path, "source_path"));
      await readFile(join(source, "SKILL.md"), "utf8");
      const name = safeName(text(context.input.name) || basename(source));
      const target = join(targetRoot, name); const temp = `${target}.tmp-${randomUUID()}`;
      await mkdir(targetRoot, { recursive: true }); await cp(source, temp, { recursive: true });
      await rm(target, { recursive: true, force: true }); await rename(temp, target);
      return success(context, { status: "installed", name, path: target }, [source, target], ["skill"]);
    },
  });
}

function registerCad(registry: ToolRegistry) {
  registry.register<Record<string, unknown>>({
    definition: { name: "interior_cad_inspect", description: "Inspect an existing DXF floor plan and return compact entity, layer, bounds, text, and readiness facts.", inputSchema: objectSchema(["path"], { path: { type: "string" } }) },
    manifest: manifest("cad.inspect", false, "resource"), parallelSafe: true,
    decodeInput: object, authorize: (context) => pathAdmission(context, requiredText(context.input.path, "path"), "read"),
    execute: async (context) => { const path = resolve(requiredText(context.input.path, "path")); const content = await readFile(path, "utf8"); const entities = [...content.matchAll(/\n(0)\r?\n([A-Z0-9_]+)/g)].map((match) => match[2]); return success(context, { path, bytes: Buffer.byteLength(content), entity_count: entities.length, entity_types: counts(entities), layers: dxfValues(content, "8"), text_samples: [...dxfValues(content, "1"), ...dxfValues(content, "3")].slice(0, 30), design_readiness: entities.length > 0 ? "inspectable" : "insufficient_evidence" }, [path], ["cad"]); },
  });
  registry.register<Record<string, unknown>>({
    definition: { name: "interior_cad_draw", description: "Generate a deterministic DXF, SVG preview, and package manifest from structured interior rooms, walls, openings, furniture, constraints, and notes.", inputSchema: { type: "object", additionalProperties: true, required: ["output_dir"] } },
    manifest: manifest("cad.draw", true, "resource"),
    decodeInput: object, authorize: (context) => pathAdmission(context, requiredText(context.input.output_dir, "output_dir"), "write"),
    execute: async (context) => {
      const outputDir = resolve(requiredText(context.input.output_dir, "output_dir")); await mkdir(outputDir, { recursive: true });
      const stem = safeName(text(context.input.name) || "interior-plan"); const dxf = join(outputDir, `${stem}.dxf`); const svg = join(outputDir, `${stem}.svg`); const packagePath = join(outputDir, "package_manifest.json");
      const model = { rooms: context.input.rooms ?? [], walls: context.input.walls ?? [], openings: context.input.openings ?? [], furniture: context.input.furniture ?? [], constraints: context.input.constraints ?? [], notes: context.input.notes ?? [] };
      await writeFile(dxf, `0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n999\n${JSON.stringify(model)}\n0\nENDSEC\n0\nEOF\n`, "utf8");
      await writeFile(svg, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 700"><rect width="1000" height="700" fill="#fff"/><text x="40" y="60" font-family="sans-serif" font-size="24">${escapeXml(stem)}</text><text x="40" y="100" font-family="sans-serif" font-size="14">Structured CAD package — inspect DXF/model manifest for geometry</text></svg>`, "utf8");
      await writeFile(packagePath, JSON.stringify({ protocol: "cardbush.cad_package.v1", name: stem, model, files: [dxf, svg], created_at: new Date().toISOString() }, null, 2), "utf8");
      return success(context, { output_dir: outputDir, dxf, preview: svg, package_manifest: packagePath }, [dxf, svg, packagePath], ["cad"], [{ artifact_id: `cad_${randomUUID()}`, type: "drawing", path: dxf, display: "attachment", metadata: {} }, { artifact_id: `preview_${randomUUID()}`, type: "image", path: svg, media_type: "image/svg+xml", display: "inline", metadata: {} }]);
    },
  });
  registry.register<Record<string, unknown>>({
    definition: { name: "interior_design_validate", description: "Validate an interior project model or CAD package for required files, structured model sections, and review readiness.", inputSchema: { type: "object", additionalProperties: true } },
    manifest: manifest("cad.validate", false, "resource"), parallelSafe: true,
    decodeInput: object,
    authorize: async (context) => {
      const candidates = [context.input.project_model_path, context.input.package_manifest_path, ...(Array.isArray(context.input.sheet_manifest_paths) ? context.input.sheet_manifest_paths : [])].map(text).filter(Boolean);
      if (!candidates.length) throw new Error("Provide project_model_path or package_manifest_path.");
      return combineAdmissions(await Promise.all(candidates.map((candidate) => pathAdmission(context, candidate, "read"))));
    },
    execute: async (context) => {
      const candidates = [context.input.project_model_path, context.input.package_manifest_path, ...(Array.isArray(context.input.sheet_manifest_paths) ? context.input.sheet_manifest_paths : [])].map(text).filter(Boolean).map((item) => resolve(item));
      if (!candidates.length) throw new Error("Provide project_model_path or package_manifest_path.");
      const checks = await Promise.all(candidates.map(async (path) => { try { const content = await readFile(path, "utf8"); return { path, exists: true, parseable_json: path.endsWith(".json") ? Boolean(JSON.parse(content)) : undefined, bytes: Buffer.byteLength(content) }; } catch (error) { return { path, exists: false, error: error instanceof Error ? error.message : String(error) }; } }));
      const valid = checks.every((item) => item.exists && item.parseable_json !== false);
      return success(context, { valid, checks, blocking_issues: checks.filter((item) => !item.exists || item.parseable_json === false) }, candidates, ["validation", "cad"]);
    },
  });
}

function registerParallel(registry: ToolRegistry) {
  registry.register<{ calls: Array<{ name: string; arguments: unknown; reason: string }> }>({
    definition: {
      name: "parallel_tools",
      description: "Execute two or more independent, read-only, parallel-safe child tools concurrently and aggregate successes and failures.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["tool_calls"],
        properties: {
          tool_calls: {
            type: "array",
            minItems: 2,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["name", "arguments"],
              properties: {
                name: { type: "string" },
                arguments: { type: "object" },
                reason: { type: "string" },
              },
            },
          },
        },
      },
    },
    manifest: manifest("tools.parallel", false, "session"),
    parallelSafe: false,
    decodeInput: (value) => {
      const input = object(value);
      if (!Array.isArray(input.tool_calls) || input.tool_calls.length < 2) {
        throw new Error("tool_calls requires at least two calls.");
      }
      return {
        calls: input.tool_calls.map((item) => {
          const call = object(item);
          return {
            name: requiredText(call.name, "name"),
            arguments: object(call.arguments),
            reason: text(call.reason),
          };
        }),
      };
    },
    execute: async (context) => {
      const catalog = new Map(registry.catalog().map((item) => [item.definition.name, item]));
      const disallowed = context.input.calls.filter((call) => {
        const entry = catalog.get(call.name);
        return call.name === "parallel_tools" || !entry?.parallelSafe || entry.manifest.dispatch_mutating;
      });
      if (disallowed.length) {
        throw new Error(`parallel_tools only accepts read-only parallel-safe tools: ${disallowed.map((item) => item.name).join(", ")}`);
      }
      const results = await Promise.all(context.input.calls.map(async (call) => {
        try {
          const child = await context.invokeTool(call.name, call.arguments);
          return { name: call.name, reason: call.reason, success: child.success, output: child.output, error: child.error };
        } catch (error) {
          return { name: call.name, reason: call.reason, success: false, error: { code: "child_exception", message: error instanceof Error ? error.message : String(error) } };
        }
      }));
      return success(context, {
        results,
        success_count: results.filter((item) => item.success).length,
        failure_count: results.filter((item) => !item.success).length,
      }, [], ["tool_results"]);
    },
  });
}

class JsonStore {
  constructor(readonly path: string) {}
  async read(): Promise<Array<Record<string, any>>> { try { const value = JSON.parse(await readFile(this.path, "utf8")); return Array.isArray(value) ? value : []; } catch { return []; } }
  async write(value: unknown) { await mkdir(dirname(this.path), { recursive: true }); const temp = `${this.path}.tmp-${randomUUID()}`; await writeFile(temp, JSON.stringify(value, null, 2), "utf8"); await rename(temp, this.path).catch(async () => { await rm(this.path, { force: true }); await rename(temp, this.path); }); }
}

function manifest(operation: string, mutating: boolean, scope: string) { return { effect_kind: mutating ? "local_state" : "observation", operation, risk: mutating ? "medium" : "low", owner: "runtime", dispatch_phase: mutating ? "write" : "read", dispatch_scope: scope, dispatch_side_effect: mutating ? "local" : "none", dispatch_mutating: mutating, dispatch_source: "registered_tool", stage_modes: [mutating ? "write" : "read"], output_kinds: ["structured_data", "facts"], handoff_exports: mutating ? [] : ["facts"], evidence_hints: [operation] }; }
function success(context: ToolHandlerContext<unknown>, output: unknown, paths: string[], categories: string[], artifacts: ToolResult["artifacts"] = []): ToolResult { return { protocol: BUSH_TOOL_RESULT_PROTOCOL, tool_call_id: context.toolCall.id, success: true, output, facts: [{ protocol: BUSH_EXECUTION_FACT_PROTOCOL, receipt_id: `receipt_${randomUUID()}`, action_manifest_id: context.actionManifest.manifest_id, status: "completed", operation: context.actionManifest.operation, effect_kind: context.actionManifest.effect_kind, owner: context.actionManifest.owner, dispatch_scope: context.actionManifest.dispatch_scope, categories, paths, execution_success: true, semantic_success: true, verification_state: "verified", error_code: "" }], artifacts, workspace_changes: [], guidance: [] }; }
async function pathAdmission(context: ToolAdmissionContext<Record<string, unknown>>, candidate: string, access: "read" | "write") { const path = resolve(candidate); const mode = context.turn?.request.permissionMode ?? "task_free"; if (mode === "all_free") return { kind: "allow" as const }; const metadata = context.turn?.request.metadata ?? {}; const roots = [metadata.workspaceDir, metadata.projectDir, ...(mode === "user_free" ? stringList(metadata.userRoots) : []), ...stringList(metadata.taskRoots)].filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => resolve(item)); if (roots.some((root) => path === root || path.startsWith(`${root}\\`) || path.startsWith(`${root}/`))) return { kind: "allow" as const }; return { kind: "ask" as const, request: { reason: `${access} requires access outside configured roots.`, actions: [access], resources: [path], capabilityIds: [`${access}:${path}`] } }; }
function combineAdmissions(decisions: Awaited<ReturnType<typeof pathAdmission>>[]) {
  const ask = decisions.filter((decision): decision is Extract<(typeof decisions)[number], { kind: "ask" }> => decision.kind === "ask");
  if (!ask.length) return { kind: "allow" as const };
  return {
    kind: "ask" as const,
    request: {
      reason: "Access outside configured roots requires approval.",
      actions: [...new Set(ask.flatMap((decision) => decision.request.actions))],
      resources: [...new Set(ask.flatMap((decision) => decision.request.resources))],
      capabilityIds: [...new Set(ask.flatMap((decision) => decision.request.capabilityIds))],
    },
  };
}
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Tool arguments must be an object."); return value as Record<string, unknown>; }
function objectSchema(required: string[], properties: Record<string, unknown>) { return { type: "object", additionalProperties: false, required, properties }; }
function text(value: unknown): string { return String(value ?? "").trim(); }
function requiredText(value: unknown, name: string): string { const result = text(value); if (!result) throw new Error(`${name} is required.`); return result; }
function stringList(value: unknown): string[] { return Array.isArray(value) ? value.map(text).filter(Boolean) : []; }
function clamp(value: unknown, min: number, max: number, fallback: number): number { const result = Number(value); return Number.isFinite(result) ? Math.max(min, Math.min(max, Math.trunc(result))) : fallback; }
function tokens(value: string): string[] { return [...new Set(value.normalize("NFKC").toLocaleLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean))]; }
function score(item: Record<string, unknown>, terms: string[]): number { const corpus = JSON.stringify(item).normalize("NFKC").toLocaleLowerCase(); return terms.reduce((sum, term) => sum + (corpus.includes(term) ? 1 : 0), 0); }
function summary(item: Record<string, unknown>) { const { content: _content, ...rest } = item; return { ...rest, char_count: text(item.content).length }; }
function safeName(value: string): string { const name = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, ""); if (!name) throw new Error("A safe name is required."); return name; }
async function listSkills(roots: string[]) { const result: Array<{ name: string; path: string }> = []; for (const root of roots) { try { for (const entry of await readdir(root, { withFileTypes: true })) if (entry.isDirectory()) result.push({ name: entry.name, path: join(root, entry.name) }); } catch {} } return result; }
function counts(values: string[]) { return Object.fromEntries([...new Set(values)].map((value) => [value, values.filter((item) => item === value).length])); }
function dxfValues(content: string, code: string) { const lines = content.split(/\r?\n/); const values: string[] = []; for (let index = 0; index < lines.length - 1; index += 1) if (lines[index]?.trim() === code) values.push(lines[index + 1]!.trim()); return [...new Set(values)].filter(Boolean); }
function escapeXml(value: string) { return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]!); }
