import {
  actionManifestTemplateSchema,
  toolDefinitionSchema,
  type ActionManifest,
  type ActionManifestTemplate,
  type RuntimePermissionAnswer,
  type RuntimePermissionScope,
  type RuntimePermissionTarget,
  type ToolCall,
  type ToolDefinition,
  type ToolCatalogEntry,
  type WorkspaceChange,
  type ModelMessage,
  type ModelRequest,
} from "@cardbush/bush-protocol";
import type { ToolNameScope } from './toolReferenceNames.js';
import type { ToolDefinitionProjector } from './toolPresentation.js';
import type { ToolResourceScheduler } from './toolResourceScheduler.js';

/** Host-owned queue admission, never supplied through model arguments. */
export interface ToolSchedulingAdmission {
  scheduler: ToolResourceScheduler;
  resources: ToolResource[];
}

export interface ToolPermissionRequest {
  reason: string;
  actions: string[];
  targets: RuntimePermissionTarget[];
  capabilityIds: string[];
  scope?: RuntimePermissionScope;
}

export type ToolAdmissionDecision =
  | { kind: "allow"; capabilityIds?: string[] }
  | { kind: "deny"; code: string; message: string; details?: Record<string, unknown> }
  | { kind: "ask"; request: ToolPermissionRequest };

export interface ToolAdmissionContext<TInput = unknown> {
  requestId: string;
  sessionId: string;
  turnId: string;
  toolCall: ToolCall;
  input: TInput;
  actionManifest: ActionManifest;
  signal?: AbortSignal;
  turn?: {
    request: ModelRequest;
    contextMessages: ModelMessage[];
    signal?: AbortSignal;
    /** Ephemeral aliases from this completed model request; never persisted as authority. */
    toolNameScope?: ToolNameScope;
  };
}

/** Reports actual permission waits, including calls delegated through another tool. */
export type ToolPermissionWaitObserver = (executionToolCallId: string, waiting: boolean) => void;

export interface ToolHandlerContext<TInput = unknown>
  extends ToolAdmissionContext<TInput> {
  capabilityIds: string[];
  /** Internal calls share the caller's lifecycle unless record is true (independent background receipt). */
  invokeTool: (name: string, input: unknown, options?: { signal?: AbortSignal; record?: boolean; onHooks?: (messages: string[], stop?: string) => void; onPermissionWait?: ToolPermissionWaitObserver; scheduling?: ToolSchedulingAdmission }) => Promise<unknown>;
  recordWorkspaceChange: (change: WorkspaceChange) => void;
}

export interface ToolRegistration<TInput = unknown> {
  /** New-catalog presentation only. Frozen declarations are never passed here. */
  projectModelDefinition?: ToolDefinitionProjector;
  /** Capability availability for discovery, independent of argument validation and permission. */
  modelAvailable?: (request: ModelRequest) => boolean;
  /** History-bound maintenance/discovery calls cannot be wrapped by call_tool. */
  directInvocation?: boolean;
  /** Independent from mutation and parallel safety. Dispatchers cannot recursively nest. */
  nestedCallable?: boolean;
  /** Canonical resources touched by this invocation. Admission still runs before locking. */
  resources?: (context: ToolAdmissionContext<TInput>) => ToolResource[] | Promise<ToolResource[]>;
  /** Private registrations are absent from host catalogs and usable only by this session. */
  sessionScope?: string;
  /** A dispatcher leaves lifecycle Hooks to the selected tool. */
  delegatesToolExecution?: boolean;
  /** A transparent invocation envelope: admission, hooks and results belong to the target. */
  forwardToolCall?: (context: Pick<ToolAdmissionContext<TInput>, 'input' | 'turn' | 'sessionId'>) => { name: string; input: unknown };
  /** Explicit MCP connection capability for trusted lifecycle hooks, never inferred from a tool name. */
  mcpHook?: {
    server: string;
    tool: string;
    readOnly?: boolean;
    modelVisible?: boolean;
    appCallable?: boolean;
    call: (input: Record<string, unknown>, options: { signal?: AbortSignal; timeoutMs: number; request: ModelRequest }) => Promise<unknown>;
  };
  mcpApp?: {
    resourceUri: string;
    /** Host-only live connection identity; a getter can invalidate it on reconnect. */
    readonly connectionIdentity?: object;
    title?: string;
    serverTitle?: string;
    readResource: (uri: string, signal?: AbortSignal) => Promise<unknown>;
  };
  definition: ToolDefinition;
  manifest: ActionManifestTemplate;
  decodeInput: (input: unknown) => TInput;
  authorize?: (
    context: ToolAdmissionContext<TInput>,
  ) => ToolAdmissionDecision | Promise<ToolAdmissionDecision>;
  execute: (context: ToolHandlerContext<TInput>) => unknown | Promise<unknown>;
  /** Pure presentation of a returned result; native execution/review data stays unchanged. */
  renderModelResult?: (result: unknown) => string | undefined;
  /** Budget-aware preview of a returned text result. A zero budget returns only
   * essential status (at most 1024 chars); the full render stays in the archive. */
  projectModelResult?: (result: unknown, maxChars: number) => string | undefined;
  /** Complete list page with continuation, delivered directly instead of an
   * archive preview. At budget 0 return a minimal page that can make progress. */
  projectModelPage?: (result: unknown, maxChars: number, call?: ToolCall) => string | undefined;
  parallelSafe?: boolean;
  executionChannel?: string;
  visibleToChild?: boolean;
  /** Optional plugin tools load through get_tool_schema/call_tool, not the default provider prefix. */
  deferredSchema?: boolean;
  registrationOwner?: string;
}

export interface PermissionResolver {
  /** executionToolCallId keeps delegated waiters distinct while toolCallId identifies their visible receipt. */
  request(
    input: ToolPermissionRequest & { toolCallId: string; executionToolCallId?: string },
    signal?: AbortSignal,
  ): Promise<RuntimePermissionAnswer>;
}

type AnyToolRegistration = ToolRegistration<unknown>;
export type ToolResource = {
  key: string;
  mode: 'read' | 'write';
  /** Optional maximum concurrent readers; writers remain exclusive. */
  capacity?: number;
};

export class ToolRegistry {
  readonly #registrations = new Map<string, AnyToolRegistration>();
  readonly #hiddenOwners = new Set<string>();

  /** Hide a disabled extension from new requests without deleting handlers frozen into active Turns. */
  setOwnerEnabled(owner: string, enabled: boolean): void {
    if (enabled) this.#hiddenOwners.delete(owner);
    else this.#hiddenOwners.add(owner);
  }

  #catalogVisible(registration: AnyToolRegistration): boolean {
    return !registration.sessionScope && !this.#hiddenOwners.has(registration.registrationOwner ?? '');
  }

  register<TInput>(candidate: ToolRegistration<TInput>): this {
    const registration = normalizeRegistration(candidate);
    const definition = registration.definition;
    if (this.#registrations.has(definition.name)) {
      throw new Error(`Tool ${definition.name} is already registered.`);
    }
    this.#registrations.set(definition.name, registration);
    return this;
  }

  replaceOwned<TInput>(owner: string, candidates: ToolRegistration<TInput>[]): this {
    const normalizedOwner = owner.trim();
    if (!normalizedOwner) throw new Error("Tool registration owner is required.");
    const replacements = candidates.map((candidate) =>
      candidate.registrationOwner === normalizedOwner && this.#registrations.get(candidate.definition.name) === candidate
        ? candidate as AnyToolRegistration
        : normalizeRegistration({ ...candidate, registrationOwner: normalizedOwner }),
    );
    const names = new Set<string>();
    for (const replacement of replacements) {
      if (names.has(replacement.definition.name)) {
        throw new Error(`Tool ${replacement.definition.name} occurs more than once.`);
      }
      names.add(replacement.definition.name);
      const existing = this.#registrations.get(replacement.definition.name);
      if (existing && existing.registrationOwner !== normalizedOwner) {
        throw new Error(`Tool ${replacement.definition.name} is owned by another registration source.`);
      }
    }
    for (const [name, registration] of this.#registrations) {
      if (registration.registrationOwner === normalizedOwner) {
        this.#registrations.delete(name);
      }
    }
    for (const replacement of replacements) {
      this.#registrations.set(replacement.definition.name, replacement);
    }
    return this;
  }

  removeOwned(owner: string): this {
    for (const [name, registration] of this.#registrations) {
      if (registration.registrationOwner === owner) this.#registrations.delete(name);
    }
    return this;
  }

  resolve(name: string): AnyToolRegistration | undefined {
    return this.#registrations.get(name);
  }

  mcpHook(server: string, tool: string, sessionId?: string): AnyToolRegistration['mcpHook'] {
    const candidates = [...this.#registrations.values()].filter(registration => (!registration.sessionScope || registration.sessionScope === sessionId) && registration.mcpHook?.server === server && registration.mcpHook.tool === tool);
    return (candidates.find(registration => registration.sessionScope === sessionId) ?? candidates[0])?.mcpHook;
  }

  renderModelResult(name: string, result: unknown): string | undefined {
    const render = this.#registrations.get(name)?.renderModelResult;
    if (!render) return undefined;
    try {
      const text = render(structuredClone(result));
      return typeof text === "string" ? text : undefined;
    } catch {
      // A presentation failure must not hide or reclassify a native Tool result.
      return undefined;
    }
  }

  projectModelResult(name: string, result: unknown, maxChars: number): string | undefined {
    try {
      const text = this.#registrations.get(name)?.projectModelResult?.(structuredClone(result), maxChars);
      return typeof text === 'string' && text.length <= (maxChars === 0 ? 1024 : maxChars) ? text : undefined;
    } catch { return undefined; }
  }

  projectModelPage(name: string, result: unknown, maxChars: number, call?: ToolCall): string | undefined {
    try {
      const text = this.#registrations.get(name)?.projectModelPage?.(structuredClone(result), maxChars, call && structuredClone(call));
      return typeof text === 'string' ? text : undefined;
    } catch { return undefined; }
  }

  definitions(): ToolDefinition[] {
    return [...this.#registrations.values()].filter(registration => this.#catalogVisible(registration)).map(({ definition }) =>
      structuredClone(definition),
    );
  }

  catalog(): ToolCatalogEntry[] {
    return [...this.#registrations.values()].filter(registration => this.#catalogVisible(registration)).map((registration) =>
      structuredClone({
        definition: registration.definition,
        manifest: registration.manifest,
        parallelSafe: registration.parallelSafe === true,
        ...(registration.executionChannel
          ? { executionChannel: registration.executionChannel }
          : {}),
        visibleToChild: registration.visibleToChild !== false,
        ...(registration.registrationOwner
          ? { registrationOwner: registration.registrationOwner }
          : {}),
      }),
    );
  }

  childDefinitions(): ToolDefinition[] {
    return [...this.#registrations.values()]
      .filter(registration => this.#catalogVisible(registration))
      .filter((registration) => registration.visibleToChild)
      .map(({ definition }) => structuredClone(definition));
  }

  isParallelSafe(name: string): boolean {
    return this.#registrations.get(name)?.parallelSafe === true;
  }

  executionChannel(name: string): string {
    return this.#registrations.get(name)?.executionChannel ?? "runtime:default";
  }
}

function normalizeRegistration<TInput>(candidate: ToolRegistration<TInput>): AnyToolRegistration {
  return {
    projectModelDefinition: candidate.projectModelDefinition,
    modelAvailable: candidate.modelAvailable,
    directInvocation: candidate.directInvocation,
    definition: toolDefinitionSchema.parse(candidate.definition),
    manifest: actionManifestTemplateSchema.parse(candidate.manifest),
    decodeInput: candidate.decodeInput as (input: unknown) => unknown,
    authorize: candidate.authorize as AnyToolRegistration["authorize"],
    execute: candidate.execute as AnyToolRegistration["execute"],
    renderModelResult: candidate.renderModelResult,
    projectModelResult: candidate.projectModelResult,
    projectModelPage: candidate.projectModelPage,
    parallelSafe: candidate.parallelSafe ?? false,
    executionChannel: candidate.executionChannel?.trim() || undefined,
    visibleToChild: candidate.visibleToChild ?? true,
    registrationOwner: candidate.registrationOwner?.trim() || undefined,
    deferredSchema: candidate.deferredSchema,
    mcpHook: candidate.mcpHook,
    mcpApp: candidate.mcpApp,
    sessionScope: candidate.sessionScope,
    delegatesToolExecution: candidate.delegatesToolExecution,
    forwardToolCall: candidate.forwardToolCall as AnyToolRegistration['forwardToolCall'],
    nestedCallable: candidate.nestedCallable ?? true,
    resources: candidate.resources as AnyToolRegistration['resources'],
  };
}
