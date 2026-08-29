import {
  actionManifestTemplateSchema,
  toolDefinitionSchema,
  type ActionManifest,
  type ActionManifestTemplate,
  type RuntimePermissionAnswer,
  type ToolCall,
  type ToolDefinition,
  type ToolCatalogEntry,
  type ToolResult,
  type ModelMessage,
  type ModelRequest,
} from "@cardbush/bush-protocol";

export interface ToolPermissionRequest {
  reason: string;
  actions: string[];
  resources: string[];
  capabilityIds: string[];
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
  invokeTool: (name: string, input: unknown) => Promise<ToolResult>;
}

export interface ToolRegistration<TInput = unknown> {
  definition: ToolDefinition;
  manifest: ActionManifestTemplate;
  decodeInput: (input: unknown) => TInput;
  authorize?: (
    context: ToolAdmissionContext<TInput>,
  ) => ToolAdmissionDecision | Promise<ToolAdmissionDecision>;
  execute: (context: ToolHandlerContext<TInput>) => ToolResult | Promise<ToolResult>;
  parallelSafe?: boolean;
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

  definitions(): ToolDefinition[] {
    return [...this.#registrations.values()].map(({ definition }) =>
      structuredClone(definition),
    );
  }

  catalog(): ToolCatalogEntry[] {
    return [...this.#registrations.values()].map((registration) =>
      structuredClone({
        definition: registration.definition,
        manifest: registration.manifest,
        parallelSafe: registration.parallelSafe === true,
        visibleToChild: registration.visibleToChild !== false,
        ...(registration.registrationOwner
          ? { registrationOwner: registration.registrationOwner }
          : {}),
      }),
    );
  }

  childDefinitions(): ToolDefinition[] {
    return [...this.#registrations.values()]
      .filter((registration) => registration.visibleToChild)
      .map(({ definition }) => structuredClone(definition));
  }

  isParallelSafe(name: string): boolean {
    return this.#registrations.get(name)?.parallelSafe === true;
  }
}

function normalizeRegistration<TInput>(candidate: ToolRegistration<TInput>): AnyToolRegistration {
  return {
    definition: toolDefinitionSchema.parse(candidate.definition),
    manifest: actionManifestTemplateSchema.parse(candidate.manifest),
    decodeInput: candidate.decodeInput as (input: unknown) => unknown,
    authorize: candidate.authorize as AnyToolRegistration["authorize"],
    execute: candidate.execute as AnyToolRegistration["execute"],
    parallelSafe: candidate.parallelSafe ?? false,
    visibleToChild: candidate.visibleToChild ?? true,
    registrationOwner: candidate.registrationOwner?.trim() || undefined,
  };
}
