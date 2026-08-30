import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { homedir } from "node:os";

import {
  BUSH_EXECUTION_FACT_PROTOCOL,
  BUSH_TOOL_RESULT_PROTOCOL,
  type ToolResult,
} from "@cardbush/bush-protocol";

import type {
  ToolAdmissionContext,
  ToolHandlerContext,
  ToolRegistration,
  ToolRegistry,
} from "./toolRegistry.js";

interface PathInput { path: string }
interface ReadFileInput extends PathInput { encoding: BufferEncoding }
interface WriteFileInput extends PathInput { content: string; encoding: BufferEncoding }
interface EditFileInput extends PathInput {
  oldText: string;
  newText: string;
  replaceAll: boolean;
  encoding: BufferEncoding;
}
interface SearchInput extends PathInput {
  query: string;
  regex: boolean;
  globs: string[];
}
interface TerminalInput {
  command: string;
  cwd: string;
  timeoutMs?: number;
}

interface Observation {
  sha256: string;
  observedAt: string;
}

export class WorkspaceObservationStore {
  readonly #observations = new Map<string, Map<string, Observation>>();
  readonly #projectObservations = new Map<string, Map<string, Observation>>();
  readonly #mutations = new Set<string>();
  readonly #persistencePath?: string;

  constructor(options: { persistencePath?: string } = {}) {
    this.#persistencePath = options.persistencePath;
    if (this.#persistencePath) this.#load();
  }

  record(sessionId: string, path: string, sha256: string, projectRoot?: string): void {
    const session = this.#observations.get(sessionId) ?? new Map<string, Observation>();
    session.set(normalizeIdentity(path), { sha256, observedAt: new Date().toISOString() });
    this.#observations.set(sessionId, session);
    if (projectRoot) {
      const project = this.#projectObservations.get(normalizeIdentity(projectRoot)) ?? new Map<string, Observation>();
      project.set(normalizeIdentity(path), { sha256, observedAt: new Date().toISOString() });
      this.#projectObservations.set(normalizeIdentity(projectRoot), project);
      this.#persist();
    }
  }

  matches(sessionId: string, path: string, sha256: string, inheritedSessionId?: string, projectRoot?: string): boolean {
    const identity = normalizeIdentity(path);
    return (
      this.#observations.get(sessionId)?.get(identity)?.sha256 === sha256 ||
      (inheritedSessionId
        ? this.#observations.get(inheritedSessionId)?.get(identity)?.sha256 === sha256
        : false) ||
      (projectRoot
        ? this.#projectObservations.get(normalizeIdentity(projectRoot))?.get(identity)?.sha256 === sha256
        : false)
    );
  }

  acquireMutation(path: string): () => void {
    const identity = normalizeIdentity(path);
    if (this.#mutations.has(identity)) {
      throw new Error(`A concurrent mutation already holds the resource lease for ${path}.`);
    }
    this.#mutations.add(identity);
    return () => this.#mutations.delete(identity);
  }

  #load(): void {
    let input: unknown;
    try {
      input = JSON.parse(readFileSync(this.#persistencePath!, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error(`Project cognition store is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("Project cognition store must be an object.");
    }
    for (const [root, records] of Object.entries(input as Record<string, unknown>)) {
      if (!records || typeof records !== "object" || Array.isArray(records)) {
        throw new Error(`Project cognition records for ${root} are invalid.`);
      }
      const project = new Map<string, Observation>();
      for (const [path, value] of Object.entries(records as Record<string, unknown>)) {
        const item = value as Partial<Observation> | null;
        if (!item || typeof item.sha256 !== "string" || typeof item.observedAt !== "string") {
          throw new Error(`Project cognition observation for ${path} is invalid.`);
        }
        project.set(path, { sha256: item.sha256, observedAt: item.observedAt });
      }
      this.#projectObservations.set(root, project);
    }
  }

  #persist(): void {
    if (!this.#persistencePath) return;
    const value = Object.fromEntries([...this.#projectObservations].map(([root, entries]) => [
      root,
      Object.fromEntries(entries),
    ]));
    mkdirSync(dirname(this.#persistencePath), { recursive: true });
    const temporary = `${this.#persistencePath}.tmp-${process.pid}`;
    writeFileSync(temporary, JSON.stringify(value), "utf8");
    try {
      renameSync(temporary, this.#persistencePath);
    } catch {
      rmSync(this.#persistencePath, { force: true });
      renameSync(temporary, this.#persistencePath);
    }
  }
}

export function registerWorkspaceTools(
  registry: ToolRegistry,
  observations: WorkspaceObservationStore = new WorkspaceObservationStore(),
  options: { createReceiptId?: () => string; createChangeId?: () => string } = {},
): WorkspaceObservationStore {
  const createReceiptId = options.createReceiptId ?? (() => `receipt_${randomUUID()}`);
  const createChangeId = options.createChangeId ?? (() => `change_${randomUUID()}`);

  registerIfMissing(registry, {
    definition: {
      name: "read_file",
      description: "Read one file exactly. Returns its absolute path, SHA-256 revision and complete content.",
      inputSchema: objectSchema({
        path: { type: "string", minLength: 1 },
        encoding: { type: "string", default: "utf8" },
      }, ["path"]),
    },
    manifest: manifest("filesystem.read", "observation", false),
    parallelSafe: true,
    decodeInput: decodeRead,
    authorize: authorizePath("read"),
    execute: async (context: ToolHandlerContext<ReadFileInput>) => {
      const path = await resolveToolPath(context, context.input.path);
      const bytes = await readFile(path);
      const sha256 = digest(bytes);
      observations.record(context.sessionId, path, sha256, workspaceRoot(context));
      return successResult(context, {
        path,
        sha256,
        content: bytes.toString(context.input.encoding),
      }, createReceiptId(), [path]);
    },
  });

  registerIfMissing(registry, {
    definition: {
      name: "search_file_content",
      description: "Search file content beneath a file or directory using ripgrep and return exact matching lines.",
      inputSchema: objectSchema({
        query: { type: "string", minLength: 1 },
        path: { type: "string", minLength: 1 },
        regex: { type: "boolean", default: false },
        globs: { type: "array", items: { type: "string" }, default: [] },
      }, ["query", "path"]),
    },
    manifest: manifest("filesystem.search", "observation", false),
    parallelSafe: true,
    decodeInput: decodeSearch,
    authorize: authorizePath("read"),
    execute: async (context: ToolHandlerContext<SearchInput>) => {
      const path = await resolveToolPath(context, context.input.path);
      const args = ["--line-number", "--column", "--no-heading", "--color", "never"];
      if (!context.input.regex) args.push("--fixed-strings");
      for (const glob of context.input.globs) args.push("--glob", glob);
      args.push("--", context.input.query, path);
      const execution = await runProcess("rg", args, {
        cwd: workspaceRoot(context),
        signal: context.signal,
      });
      if (execution.exitCode !== 0 && execution.exitCode !== 1) {
        throw new Error(execution.stderr || `ripgrep exited with code ${execution.exitCode}.`);
      }
      return successResult(context, {
        path,
        query: context.input.query,
        matched: execution.exitCode === 0,
        output: execution.stdout,
      }, createReceiptId(), [path]);
    },
  });

  registerIfMissing(registry, {
    definition: {
      name: "write_file",
      description: "Create or replace one file. Existing files must have been read at their current SHA-256 revision first.",
      inputSchema: objectSchema({
        path: { type: "string", minLength: 1 },
        content: { type: "string" },
        encoding: { type: "string", default: "utf8" },
      }, ["path", "content"]),
    },
    manifest: manifest("filesystem.write", "filesystem_change", true),
    decodeInput: decodeWrite,
    authorize: authorizePath("write"),
    execute: async (context: ToolHandlerContext<WriteFileInput>) => {
      const path = await resolveToolPath(context, context.input.path, true);
      const release = observations.acquireMutation(path);
      try {
        const before = await optionalBytes(path);
        assertObservedIfExisting(context, observations, path, before);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, context.input.content, { encoding: context.input.encoding });
        const after = await readFile(path);
        const afterHash = digest(after);
        observations.record(context.sessionId, path, afterHash, workspaceRoot(context));
        return changeResult(
          context,
          path,
          before,
          after,
          before ? "modified" : "added",
          createReceiptId(),
          createChangeId(),
        );
      } finally {
        release();
      }
    },
  });

  registerIfMissing(registry, {
    definition: {
      name: "edit_file",
      description: "Replace exact text in one previously read file. Fails if the current file revision was not observed or the old text is absent/ambiguous.",
      inputSchema: objectSchema({
        path: { type: "string", minLength: 1 },
        old_text: { type: "string", minLength: 1 },
        new_text: { type: "string" },
        replace_all: { type: "boolean", default: false },
        encoding: { type: "string", default: "utf8" },
      }, ["path", "old_text", "new_text"]),
    },
    manifest: manifest("filesystem.edit", "filesystem_change", true),
    decodeInput: decodeEdit,
    authorize: authorizePath("write"),
    execute: async (context: ToolHandlerContext<EditFileInput>) => {
      const path = await resolveToolPath(context, context.input.path);
      const release = observations.acquireMutation(path);
      try {
        const before = await readFile(path);
        assertObservedIfExisting(context, observations, path, before);
        const source = before.toString(context.input.encoding);
        const count = occurrences(source, context.input.oldText);
        if (count === 0) throw new Error("old_text was not found in the current file revision.");
        if (!context.input.replaceAll && count !== 1) {
          throw new Error(`old_text matched ${count} times; set replace_all or provide a unique value.`);
        }
        const next = context.input.replaceAll
          ? source.split(context.input.oldText).join(context.input.newText)
          : source.replace(context.input.oldText, context.input.newText);
        await writeFile(path, next, { encoding: context.input.encoding });
        const after = await readFile(path);
        const afterHash = digest(after);
        observations.record(context.sessionId, path, afterHash, workspaceRoot(context));
        return changeResult(
          context,
          path,
          before,
          after,
          "modified",
          createReceiptId(),
          createChangeId(),
        );
      } finally {
        release();
      }
    },
  });

  registerIfMissing(registry, {
    definition: {
      name: "terminal_exec",
      description: "Execute one command in the selected working directory and return the complete stdout, stderr and exit code. Commands are not rewritten or interpreted by Runtime.",
      inputSchema: objectSchema({
        command: { type: "string", minLength: 1 },
        cwd: { type: "string" },
        timeout_ms: { type: "integer", minimum: 1 },
      }, ["command"]),
    },
    manifest: manifest("terminal.execute", "process_execution", true),
    decodeInput: decodeTerminal,
    authorize: async (context: ToolAdmissionContext<TerminalInput>) => {
      const cwd = await resolveToolPath(context, context.input.cwd || workspaceRoot(context), true);
      return pathAdmission(context, cwd, "execute");
    },
    execute: async (context: ToolHandlerContext<TerminalInput>) => {
      const cwd = await resolveToolPath(context, context.input.cwd || workspaceRoot(context), true);
      const execution = await runShell(context.input.command, {
        cwd,
        timeoutMs: context.input.timeoutMs,
        signal: context.signal,
      });
      const receiptId = createReceiptId();
      const completed = execution.exitCode === 0 && !execution.timedOut;
      return {
        ...successResult(context, {
          command: context.input.command,
          cwd,
          ...execution,
        }, receiptId, [cwd]),
        success: completed,
        facts: [executionFact(context, receiptId, [cwd], completed)],
        ...(completed
          ? {}
          : {
              error: {
                code: execution.timedOut ? "terminal_timeout" : "terminal_exit_nonzero",
                message: execution.timedOut
                  ? "The command timed out."
                  : `The command exited with code ${execution.exitCode}.`,
                details: { exitCode: execution.exitCode },
              },
            }),
      };
    },
  });

  return observations;
}

function registerIfMissing<T>(registry: ToolRegistry, registration: ToolRegistration<T>): void {
  if (!registry.resolve(registration.definition.name)) registry.register(registration);
}

function manifest(operation: string, effectKind: string, mutating: boolean) {
  return {
    effect_kind: effectKind,
    operation,
    risk: mutating ? "medium" : "low",
    owner: "runtime_workspace",
    dispatch_phase: "execution",
    dispatch_scope: "resource",
    dispatch_side_effect: mutating ? effectKind : "none",
    dispatch_mutating: mutating,
    dispatch_source: "registered_tool",
    stage_modes: ["execute"],
    output_kinds: ["structured_data"],
    handoff_exports: [],
    evidence_hints: [effectKind],
  };
}

function authorizePath(action: "read" | "write") {
  return async (context: ToolAdmissionContext<PathInput>) => {
    const path = await resolveToolPath(context, context.input.path, action === "write");
    return pathAdmission(context, path, action);
  };
}

async function pathAdmission(
  context: ToolAdmissionContext<unknown>,
  path: string,
  action: string,
): Promise<
  | { kind: "allow" }
  | {
      kind: "ask";
      request: {
        reason: string;
        actions: string[];
        resources: string[];
        capabilityIds: string[];
      };
    }
> {
  const mode = permissionMode(context);
  if (mode === "all_free") return { kind: "allow" } as const;
  const roots = await Promise.all(allowedRoots(context, mode).map(canonicalPath));
  if (roots.some((root) => isWithin(root, path))) return { kind: "allow" } as const;
  const capabilityId = capability(action, path);
  return {
    kind: "ask" as const,
    request: {
      reason: `${action} requires access outside the ${mode === "user_free" ? "user" : "task"} roots.`,
      actions: [action],
      resources: [path],
      capabilityIds: [capabilityId],
    },
  };
}

function permissionMode(context: ToolAdmissionContext<unknown>): "task_free" | "user_free" | "all_free" {
  const candidate = context.turn?.request.permissionMode;
  return candidate === "user_free" || candidate === "all_free" ? candidate : "task_free";
}

function allowedRoots(
  context: ToolAdmissionContext<unknown>,
  mode: "task_free" | "user_free",
): string[] {
  const metadata = context.turn?.request.metadata ?? {};
  const taskRoots = rootStringArray(metadata.taskRoots);
  const configuredUserRoots = rootStringArray(metadata.userRoots);
  const userRoots = mode === "user_free"
    ? (configuredUserRoots.length > 0 ? configuredUserRoots : [homedir()])
    : [];
  return [...new Set([workspaceRoot(context), ...taskRoots, ...userRoots].map((item) => resolve(item)))];
}

function rootStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

async function resolveToolPath(
  context: ToolAdmissionContext<unknown>,
  candidate: string,
  allowMissing = false,
): Promise<string> {
  const root = workspaceRoot(context);
  const lexical = resolve(isAbsolute(candidate) ? candidate : resolve(root, candidate));
  try {
    return await realpath(lexical);
  } catch (error) {
    if (!allowMissing) throw error;
    let ancestor = dirname(lexical);
    while (true) {
      try {
        const canonicalAncestor = await realpath(ancestor);
        return resolve(canonicalAncestor, relative(ancestor, lexical));
      } catch {
        const parent = dirname(ancestor);
        if (parent === ancestor) throw error;
        ancestor = parent;
      }
    }
  }
}

function workspaceRoot(context: ToolAdmissionContext<unknown>): string {
  const metadata = context.turn?.request.metadata ?? {};
  const candidate = [metadata.workspaceDir, metadata.projectDir, metadata.sessionWorkspaceDir]
    .find((value) => typeof value === "string" && value.trim());
  if (typeof candidate !== "string") throw new Error("Runtime request has no workspaceDir.");
  return resolve(candidate);
}

function inheritedObservationSessionId(context: ToolHandlerContext<unknown>): string | undefined {
  const candidate = context.turn?.request.metadata.inheritedObservationSessionId;
  return typeof candidate === "string" && candidate.trim() ? candidate : undefined;
}

function assertObservedIfExisting(
  context: ToolHandlerContext<unknown>,
  observations: WorkspaceObservationStore,
  path: string,
  bytes: Buffer | undefined,
): void {
  if (!bytes) return;
  const sha256 = digest(bytes);
  if (
    !observations.matches(
      context.sessionId,
      path,
      sha256,
      inheritedObservationSessionId(context),
      workspaceRoot(context),
    )
  ) {
    throw new Error(
      `Current file revision ${sha256} has not been observed by this Agent context; read_file first.`,
    );
  }
}

function successResult(
  context: ToolHandlerContext<unknown>,
  output: unknown,
  receiptId: string,
  paths: string[],
): ToolResult {
  return {
    protocol: BUSH_TOOL_RESULT_PROTOCOL,
    tool_call_id: context.toolCall.id,
    success: true,
    output,
    facts: [executionFact(context, receiptId, paths, true)],
    artifacts: [],
    workspace_changes: [],
    guidance: [],
  };
}

function changeResult(
  context: ToolHandlerContext<unknown>,
  path: string,
  before: Buffer | undefined,
  after: Buffer,
  status: "added" | "modified",
  receiptId: string,
  changeId: string,
): ToolResult {
  return {
    ...successResult(context, { path, sha256: digest(after) }, receiptId, [path]),
    workspace_changes: [{
      change_id: changeId,
      path,
      status,
      ...(before ? {} : { additions: countLines(after) }),
      ...(before ? { before_hash: digest(before) } : {}),
      after_hash: digest(after),
      metadata: {
        ...(before ? { beforeContentBase64: before.toString("base64") } : {}),
      },
    }],
  };
}

function executionFact(
  context: ToolHandlerContext<unknown>,
  receiptId: string,
  paths: string[],
  succeeded: boolean,
) {
  return {
    protocol: BUSH_EXECUTION_FACT_PROTOCOL,
    receipt_id: receiptId,
    action_manifest_id: context.actionManifest.manifest_id,
    status: succeeded ? "succeeded" : "failed",
    operation: context.actionManifest.operation,
    effect_kind: context.actionManifest.effect_kind,
    owner: context.actionManifest.owner,
    dispatch_scope: context.actionManifest.dispatch_scope,
    categories: [context.actionManifest.effect_kind],
    paths,
    execution_success: true,
    semantic_success: succeeded,
    verification_state: succeeded ? "verified" as const : "failed" as const,
    error_code: succeeded ? "" : "execution_failed",
  };
}

function decodeRead(input: unknown): ReadFileInput {
  const object = objectInput(input);
  return { path: requiredString(object.path, "path"), encoding: encoding(object.encoding) };
}

function decodeWrite(input: unknown): WriteFileInput {
  const object = objectInput(input);
  return {
    path: requiredString(object.path, "path"),
    content: stringValue(object.content, "content"),
    encoding: encoding(object.encoding),
  };
}

function decodeEdit(input: unknown): EditFileInput {
  const object = objectInput(input);
  return {
    path: requiredString(object.path, "path"),
    oldText: requiredString(object.old_text, "old_text", false),
    newText: stringValue(object.new_text, "new_text"),
    replaceAll: booleanValue(object.replace_all, false),
    encoding: encoding(object.encoding),
  };
}

function decodeSearch(input: unknown): SearchInput {
  const object = objectInput(input);
  return {
    query: requiredString(object.query, "query", false),
    path: requiredString(object.path, "path"),
    regex: booleanValue(object.regex, false),
    globs: stringArray(object.globs, "globs"),
  };
}

function decodeTerminal(input: unknown): TerminalInput {
  const object = objectInput(input);
  const timeout = object.timeout_ms;
  if (timeout !== undefined && (!Number.isInteger(timeout) || Number(timeout) < 1)) {
    throw new Error("timeout_ms must be a positive integer.");
  }
  return {
    command: requiredString(object.command, "command", false),
    cwd: typeof object.cwd === "string" ? object.cwd.trim() : "",
    ...(timeout === undefined ? {} : { timeoutMs: Number(timeout) }),
  };
}

function objectInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("tool input must be an object.");
  }
  return input as Record<string, unknown>;
}

function requiredString(value: unknown, name: string, trim = true): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string.`);
  const output = trim ? value.trim() : value;
  if (!output) throw new Error(`${name} is required.`);
  return output;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string.`);
  return value;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error("boolean value expected.");
  return value;
}

function stringArray(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${name} must contain non-empty strings.`);
  }
  return value.map((item) => String(item));
}

function encoding(value: unknown): BufferEncoding {
  const candidate = typeof value === "string" && value.trim() ? value.trim() : "utf8";
  if (!Buffer.isEncoding(candidate)) throw new Error(`Unsupported encoding ${candidate}.`);
  return candidate as BufferEncoding;
}

function objectSchema(properties: Record<string, unknown>, required: string[]) {
  return { type: "object", additionalProperties: false, required, properties };
}

async function optionalBytes(path: string): Promise<Buffer | undefined> {
  try { return await readFile(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizeIdentity(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isWithin(root: string, path: string): boolean {
  const value = relative(resolve(root), resolve(path));
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

function capability(action: string, path: string): string {
  return `capability:${action}:${createHash("sha256").update(normalizeIdentity(path)).digest("hex")}`;
}

function occurrences(value: string, search: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = value.indexOf(search, offset)) >= 0) {
    count += 1;
    offset += search.length;
  }
  return count;
}

function countLines(value: Buffer): number {
  if (value.length === 0) return 0;
  let count = 1;
  for (const byte of value) {
    if (byte === 10) count += 1;
  }
  return value[value.length - 1] === 10 ? count - 1 : count;
}

async function canonicalPath(path: string): Promise<string> {
  return realpath(resolve(path));
}

interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runShell(
  command: string,
  options: { cwd: string; timeoutMs?: number; signal?: AbortSignal },
): Promise<ProcessResult> {
  return runProcess(command, [], { ...options, shell: true });
}

function runProcess(
  file: string,
  args: string[],
  options: {
    cwd: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    shell?: boolean;
  },
): Promise<ProcessResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      shell: options.shell ?? false,
      windowsHide: true,
      signal: options.signal,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
        }, options.timeoutMs)
      : undefined;
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (timeout) clearTimeout(timeout);
      resolvePromise({ exitCode, stdout, stderr, timedOut });
    });
  });
}
