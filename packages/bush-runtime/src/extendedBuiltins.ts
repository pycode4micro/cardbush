import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";

import type { ToolAdmissionContext, ToolHandlerContext, ToolRegistry } from "./toolRegistry.js";
import { LogicMemoryStore } from "./logicMemory.js";

export interface ExtendedBuiltinOptions {
  dataRoot?: string;
  readToolResult?: (locator: string) => unknown;
  logicMemory?: LogicMemoryStore;
}

export function registerExtendedBuiltins(registry: ToolRegistry, options: ExtendedBuiltinOptions = {}): void {
  const dataRoot = resolve(options.dataRoot || join(process.cwd(), ".cardbush-runtime"));
  registerLogic(registry, options.logicMemory ?? new LogicMemoryStore(join(dataRoot, "lem", "logic.json")));
  registerArchivedToolResult(registry, options.readToolResult);
  registerImageInput(registry);
  registerSchedule(registry, dataRoot);
  registerParallel(registry);
}

function registerLogic(registry: ToolRegistry, store: LogicMemoryStore) {
  registry.register<Record<string, unknown>>({
    definition: {
      name: "consult_logic",
      description: "Consult local LEM advisory reasoning memory before consequential judgments, evidence conflicts, correction-direction decisions, complex tradeoffs, delegation, or uncertain completion criteria. Retrieved records are reflection candidates, not task answers or policy.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: { type: "string", minLength: 1 },
          scenario_conditions: {
            oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
          },
          decision_context: { type: "string" },
          decision_phase: {
            type: "string",
            enum: ["before_action", "after_tool_result", "before_delegation", "before_final", "recovery", "postmortem"],
          },
          task_type: { type: "string" },
          tool_focus: { type: "string" },
          cognitive_patterns: {
            oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
          },
          max_results: { type: "integer", minimum: 1, maximum: 10, default: 5 },
        },
      },
    },
    manifest: manifest("logic.consult", false, "session"),
    parallelSafe: true,
    visibleToChild: true,
    decodeInput: (value) => {
      const input = object(value);
      requiredText(input.query, "query");
      const conditions = [
        ...stringList(input.scenario_conditions),
        text(input.decision_phase),
        text(input.task_type),
        text(input.tool_focus),
      ].filter(Boolean);
      return { ...input, scenario_conditions: conditions };
    },
    execute: async (context) =>
      success(context, await store.consult(context.input), [store.path], ["logic", "lem"]),
  });
  registry.register<Record<string, unknown>>({
    definition: {
      name: "learn_logic",
      description: "Store a local LEM reasoning lesson as scenario-bias-correction memory, or record reward feedback for an existing logic_id. Store how to think, not task instructions or domain answers.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", enum: ["learn", "feedback"], default: "learn" },
          logic_id: { type: "string" },
          scenario: { type: "string" },
          bias: { type: "string" },
          correction: { type: "string" },
          reflection_question: { type: "string" },
          cognitive_patterns: {
            oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
          },
          conditions: {
            oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
          },
          chain: {
            oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
          },
          evidence: { type: "string" },
          outcome: { type: "string" },
          evidence_state: { type: "string", enum: ["verified", "unverified"] },
          tags: {
            oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
          },
          confidence: { type: "number", minimum: 0.1, maximum: 0.98, default: 0.76 },
          background: { type: "boolean", default: false },
          feedback: {
            type: "string",
            enum: ["thumbs_up", "thumbs_down", "helpful", "unhelpful", "success", "failure", "positive", "negative"],
          },
          reward: { type: "number", minimum: -1, maximum: 1 },
          rating: { type: "number", minimum: -5, maximum: 5 },
          source: { type: "string" },
          source_id: { type: "string" },
          note: { type: "string" },
        },
        oneOf: [
          { required: ["scenario"] },
          { required: ["action", "logic_id"] },
          { required: ["logic_id", "feedback"] },
          { required: ["logic_id", "reward"] },
        ],
      },
    },
    manifest: manifest("logic.learn", true, "session"),
    parallelSafe: false,
    visibleToChild: true,
    decodeInput: object,
    execute: async (context) =>
      success(context, await store.learn(context.input), [store.path], ["logic", "lem"]),
  });
}

function registerArchivedToolResult(
  registry: ToolRegistry,
  readToolResult?: (locator: string) => unknown,
) {
  registry.register<{ locator: string; offset: number; maxChars: number }>({
    definition: {
      name: "read_archived_tool_result",
      description: "Read an exact chunk from a complete Tool result archived by Runtime. Call only when a preceding Tool result explicitly provides a tool-result:// locator. Never pass a local path, file:// URL, Skill resource, or guessed locator.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["locator"],
        properties: {
          locator: {
            type: "string",
            minLength: 1,
            pattern: "^tool-result://",
            description: "Exact tool-result:// locator returned by a preceding Tool result.",
          },
          offset: { type: "integer", minimum: 0, default: 0 },
          max_chars: { type: "integer", minimum: 500, maximum: 50000, default: 12000 },
        },
      },
    },
    manifest: manifest("tool_result_archive.read", false, "session"),
    parallelSafe: true,
    decodeInput: (value) => {
      const input = object(value);
      const locator = requiredText(input.locator, "locator");
      if (!locator.startsWith("tool-result://")) {
        throw new Error("locator must be the exact tool-result:// value returned by a preceding Tool result.");
      }
      return {
        locator,
        offset: clamp(input.offset, 0, Number.MAX_SAFE_INTEGER, 0),
        maxChars: clamp(input.max_chars, 500, 50_000, 12_000),
      };
    },
    execute: async (context) => {
      if (!readToolResult) throw new Error("Archived Tool result lookup is unavailable.");
      const archived = readToolResult(context.input.locator);
      const serialized = JSON.stringify(archived);
      if (typeof serialized !== "string") throw new Error("Archived Tool result could not be serialized.");
      const offset = Math.min(context.input.offset, serialized.length);
      return success(context, {
        locator: context.input.locator,
        offset,
        next_offset: Math.min(serialized.length, offset + context.input.maxChars),
        complete: offset + context.input.maxChars >= serialized.length,
        text: serialized.slice(offset, offset + context.input.maxChars),
      }, [], ["tool_result_archive"]);
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
    manifest: manifest("schedule.manage", true, "session"), visibleToChild: true,
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

function registerParallel(registry: ToolRegistry) {
  registry.register<{ calls: Array<{ name: string; arguments: unknown; reason: string }> }>({
    definition: {
      name: "parallel_tools",
      description: "Execute two or more independent, read-only, parallel-safe tools concurrently and aggregate successes and failures. This is not an Agent-delegation mechanism and does not accept subagent or team_delegate.",
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
        return call.name === "parallel_tools" || !entry?.parallelSafe;
      });
      if (disallowed.length) {
        throw new Error(`parallel_tools only accepts read-only parallel-safe tools: ${disallowed.map((item) => item.name).join(", ")}`);
      }
      const results = await Promise.all(context.input.calls.map(async (call) => {
        try {
          const child = await context.invokeTool(call.name, call.arguments);
          return { name: call.name, reason: call.reason, returned: true, result: child };
        } catch (error) {
          return { name: call.name, reason: call.reason, success: false, error: { code: "child_exception", message: error instanceof Error ? error.message : String(error) } };
        }
      }));
      return success(context, {
        results,
        returned_count: results.filter((item) => item.returned === true).length,
        failure_count: results.filter((item) => item.returned !== true).length,
      }, [], ["tool_results"]);
    },
  });
}

class JsonStore {
  constructor(readonly path: string) {}
  async read(): Promise<Array<Record<string, any>>> { try { const value = JSON.parse(await readFile(this.path, "utf8")); return Array.isArray(value) ? value : []; } catch { return []; } }
  async write(value: unknown) { await mkdir(dirname(this.path), { recursive: true }); const temp = `${this.path}.tmp-${randomUUID()}`; await writeFile(temp, JSON.stringify(value, null, 2), "utf8"); await rename(temp, this.path).catch(async () => { await rm(this.path, { force: true }); await rename(temp, this.path); }); }
}

function manifest(operation: string, mutating: boolean, scope: string) { return { effect_kind: mutating ? "local_state" : "observation", operation, risk: mutating ? "medium" : "low", owner: "runtime", dispatch_scope: scope, mutating }; }
function success(_context: ToolHandlerContext<unknown>, output: unknown, _paths: string[], _categories: string[], artifacts: Array<Record<string, unknown>> = []): unknown {
  if (artifacts.length === 0) return output;
  const value = output && typeof output === "object" && !Array.isArray(output)
    ? output as Record<string, unknown>
    : { value: output };
  return { ...value, artifacts };
}
async function pathAdmission(context: ToolAdmissionContext<Record<string, unknown>>, candidate: string, access: "read" | "write") { const path = resolve(candidate); const mode = context.turn?.request.permissionMode ?? "task_free"; if (mode === "all_free") return { kind: "allow" as const }; const metadata = context.turn?.request.metadata ?? {}; const configuredUserRoots = stringList(metadata.userRoots); const userRoots = mode === "user_free" ? (configuredUserRoots.length > 0 ? configuredUserRoots : [homedir()]) : []; const roots = [metadata.workspaceDir, metadata.projectDir, ...userRoots, ...stringList(metadata.taskRoots)].filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => resolve(item)); if (roots.some((root) => path === root || path.startsWith(`${root}\\`) || path.startsWith(`${root}/`))) return { kind: "allow" as const }; return { kind: "ask" as const, request: { reason: `${access} requires access outside configured roots.`, actions: [access], targets: [{ kind: "filesystem_path" as const, value: path }], capabilityIds: [`${access}:${path}`], scope: { mode: mode === "user_free" ? "user_free" as const : "task_free" as const, roots } } }; }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Tool arguments must be an object."); return value as Record<string, unknown>; }
function objectSchema(required: string[], properties: Record<string, unknown>) { return { type: "object", additionalProperties: false, required, properties }; }
function text(value: unknown): string { return String(value ?? "").trim(); }
function requiredText(value: unknown, name: string): string { const result = text(value); if (!result) throw new Error(`${name} is required.`); return result; }
function stringList(value: unknown): string[] { return (Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,;\n]/) : []).map(text).filter(Boolean); }
function clamp(value: unknown, min: number, max: number, fallback: number): number { const result = Number(value); return Number.isFinite(result) ? Math.max(min, Math.min(max, Math.trunc(result))) : fallback; }
