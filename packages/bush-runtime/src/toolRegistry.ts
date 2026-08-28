import {
  actionManifestTemplateSchema,
  toolDefinitionSchema,
  type ActionManifest,
  type ActionManifestTemplate,
  type RuntimePermissionAnswer,
  type ToolCall,
  type ToolDefinition,
  type ToolResult,
} from "@cardbush/bush-protocol";

export interface ToolPermissionRequest {
  reason: string;
  actions: string[];
  resources: string[];
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
}

export interface ToolHandlerContext<TInput = unknown>
  extends ToolAdmissionContext<TInput> {
  capabilityIds: string[];
}

export interface ToolRegistration<TInput = unknown> {
  definition: ToolDefinition;
  manifest: ActionManifestTemplate;
  decodeInput: (input: unknown) => TInput;
  authorize?: (
    context: ToolAdmissionContext<TInput>,
  ) => ToolAdmissionDecision | Promise<ToolAdmissionDecision>;
  execute: (context: ToolHandlerContext<TInput>) => ToolResult | Promise<ToolResult>;
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
    const definition = toolDefinitionSchema.parse(candidate.definition);
    const manifest = actionManifestTemplateSchema.parse(candidate.manifest);
    if (this.#registrations.has(definition.name)) {
      throw new Error(`Tool ${definition.name} is already registered.`);
    }
    this.#registrations.set(definition.name, {
      definition,
      manifest,
      decodeInput: candidate.decodeInput as (input: unknown) => unknown,
      authorize: candidate.authorize as AnyToolRegistration["authorize"],
      execute: candidate.execute as AnyToolRegistration["execute"],
    });
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
}
