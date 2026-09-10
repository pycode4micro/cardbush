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
  };
}

export interface ToolHandlerContext<TInput = unknown>
  extends ToolAdmissionContext<TInput> {
  capabilityIds: string[];
  invokeTool: (name: string, input: unknown) => Promise<unknown>;
  recordWorkspaceChange: (change: WorkspaceChange) => void;
}

export interface ToolRegistration<TInput = unknown> {
  /** Private registrations are absent from host catalogs and usable only by this session. */
  sessionScope?: string;
  /** A dispatcher leaves lifecycle Hooks to the selected tool. */
  delegatesToolExecution?: boolean;
  /** Explicit MCP connection capability for trusted lifecycle hooks, never inferred from a tool name. */
  mcpHook?: {
    server: string;
    tool: string;
    modelVisible?: boolean;
    appCallable?: boolean;
    call: (input: Record<string, unknown>, options: { signal?: AbortSignal; timeoutMs: number; request: ModelRequest }) => Promise<unknown>;
  };
  mcpApp?: {
    resourceUri: string;
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
  parallelSafe?: boolean;
  executionChannel?: string;
  visibleToChild?: boolean;
  registrationOwner?: string;
}

export interface PermissionResolver {
  request(
    input: ToolPermissionRequest & { toolCallId: string },
    signal?: AbortSignal,
  ): Promise<RuntimePermissionAnswer>;
}

type AnyToolRegistration = ToolRegistration<unknown>;

export class ToolRegistry {
  readonly #registrations = new Map<string, AnyToolRegistration>();

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
      normalizeRegistration({ ...candidate, registrationOwner: normalizedOwner }),
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

  definitions(): ToolDefinition[] {
    return [...this.#registrations.values()].filter(registration => !registration.sessionScope).map(({ definition }) =>
      structuredClone(definition),
    );
  }

  catalog(): ToolCatalogEntry[] {
    return [...this.#registrations.values()].filter(registration => !registration.sessionScope).map((registration) =>
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
      .filter(registration => !registration.sessionScope)
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
    definition: toolDefinitionSchema.parse(candidate.definition),
    manifest: actionManifestTemplateSchema.parse(candidate.manifest),
    decodeInput: candidate.decodeInput as (input: unknown) => unknown,
    authorize: candidate.authorize as AnyToolRegistration["authorize"],
    execute: candidate.execute as AnyToolRegistration["execute"],
    renderModelResult: candidate.renderModelResult,
    parallelSafe: candidate.parallelSafe ?? false,
    executionChannel: candidate.executionChannel?.trim() || undefined,
    visibleToChild: candidate.visibleToChild ?? true,
    registrationOwner: candidate.registrationOwner?.trim() || undefined,
    mcpHook: candidate.mcpHook,
    mcpApp: candidate.mcpApp,
    sessionScope: candidate.sessionScope,
    delegatesToolExecution: candidate.delegatesToolExecution,
  };
}
