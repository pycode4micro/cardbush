export const PRODUCT_HOST_IPC_PROTOCOL = "cardbush.product_host_ipc.v1" as const;

export type RuntimeAssetCategory = "prompts" | "skills" | "agent_profiles" | "teams";

export type ProductHostCommand =
  | { protocol: typeof PRODUCT_HOST_IPC_PROTOCOL; kind: "models.get" }
  | {
      protocol: typeof PRODUCT_HOST_IPC_PROTOCOL;
      kind: "models.update";
      config: Record<string, unknown>;
    }
  | {
      protocol: typeof PRODUCT_HOST_IPC_PROTOCOL;
      kind: "model.resolve";
      modelId: string;
    }
  | { protocol: typeof PRODUCT_HOST_IPC_PROTOCOL; kind: "apps.get" }
  | { protocol: typeof PRODUCT_HOST_IPC_PROTOCOL; kind: "mcp.get" }
  | { protocol: typeof PRODUCT_HOST_IPC_PROTOCOL; kind: "subagents.get" }
  | {
      protocol: typeof PRODUCT_HOST_IPC_PROTOCOL;
      kind: "apps.update";
      config: Record<string, unknown>;
    }
  | { protocol: typeof PRODUCT_HOST_IPC_PROTOCOL; kind: "mcp.update"; config: Record<string, unknown> }
  | { protocol: typeof PRODUCT_HOST_IPC_PROTOCOL; kind: "maintenance.clear_conversations" }
  | { protocol: typeof PRODUCT_HOST_IPC_PROTOCOL; kind: "maintenance.clear_logs_cache" }
  | { protocol: typeof PRODUCT_HOST_IPC_PROTOCOL; kind: "maintenance.runtime_assets.plan" }
  | {
      protocol: typeof PRODUCT_HOST_IPC_PROTOCOL;
      kind: "maintenance.runtime_assets.reset";
      categories: RuntimeAssetCategory[];
      confirm: true;
    }
  | { protocol: typeof PRODUCT_HOST_IPC_PROTOCOL; kind: "maintenance.diagnostics" };

export interface ProductModelHost {
  get(): Promise<Record<string, unknown>>;
  update(config: Record<string, unknown>): Promise<Record<string, unknown>>;
  resolve(modelId: string): Promise<Record<string, unknown>>;
}

export interface ProductAppsHost {
  get(): Promise<unknown>;
  update(config: Record<string, unknown>): Promise<unknown>;
}
export interface ProductMcpHost extends ProductAppsHost {}

export interface ProductSubagentHost {
  get(): Promise<unknown>;
}

export interface ProductMaintenanceHost {
  clearConversations(): Promise<Record<string, unknown>>;
  clearLogsCache(): Promise<Record<string, unknown>>;
  runtimeAssetPlan(): Promise<Record<string, unknown>>;
  resetRuntimeAssets(
    categories: RuntimeAssetCategory[],
  ): Promise<Record<string, unknown>>;
  diagnostics(): Promise<Record<string, unknown>>;
}

export interface ProductHostResult {
  protocol: typeof PRODUCT_HOST_IPC_PROTOCOL;
  ok: true;
  value: unknown;
}

export interface ProductHostFailure {
  protocol: typeof PRODUCT_HOST_IPC_PROTOCOL;
  ok: false;
  error: { code: string; message: string };
}

export class ProductHost {
  constructor(
    readonly model?: ProductModelHost,
    readonly maintenance?: ProductMaintenanceHost,
    readonly apps?: ProductAppsHost,
    readonly mcp?: ProductMcpHost,
    readonly subagents?: ProductSubagentHost,
  ) {}

  async execute(input: unknown): Promise<ProductHostResult | ProductHostFailure> {
    try {
      const command = decodeProductHostCommand(input);
      const value = await this.#execute(command);
      return { protocol: PRODUCT_HOST_IPC_PROTOCOL, ok: true, value };
    } catch (error) {
      return {
        protocol: PRODUCT_HOST_IPC_PROTOCOL,
        ok: false,
        error: {
          code: errorCode(error),
          message: errorMessage(error),
        },
      };
    }
  }

  async #execute(command: ProductHostCommand): Promise<unknown> {
    switch (command.kind) {
      case "models.get":
        if (!this.model) {
          throw new ProductHostProtocolError(
            "product_model_host_unavailable",
            "The Product Model Host is not installed",
          );
        }
        return this.model.get();
      case "models.update":
        if (!this.model) {
          throw new ProductHostProtocolError(
            "product_model_host_unavailable",
            "The Product Model Host is not installed",
          );
        }
        return this.model.update(command.config);
      case "model.resolve":
        if (!this.model) {
          throw new ProductHostProtocolError(
            "product_model_host_unavailable",
            "The Product Model Host is not installed",
          );
        }
        return this.model.resolve(command.modelId);
      case "apps.get":
        return this.#apps().get();
      case "apps.update":
        return this.#apps().update(command.config);
      case "mcp.get":
        return this.#mcp().get();
      case "subagents.get":
        return this.#subagents().get();
      case "mcp.update":
        return this.#mcp().update(command.config);
      case "maintenance.clear_conversations":
        return this.#maintenance().clearConversations();
      case "maintenance.clear_logs_cache":
        return this.#maintenance().clearLogsCache();
      case "maintenance.runtime_assets.plan":
        return this.#maintenance().runtimeAssetPlan();
      case "maintenance.runtime_assets.reset":
        return this.#maintenance().resetRuntimeAssets(command.categories);
      case "maintenance.diagnostics":
        return this.#maintenance().diagnostics();
    }
  }

  #maintenance(): ProductMaintenanceHost {
    if (!this.maintenance) {
      throw new ProductHostProtocolError(
        "product_maintenance_unavailable",
        "The Product Maintenance Host is not installed",
      );
    }
    return this.maintenance;
  }

  #apps(): ProductAppsHost {
    if (!this.apps) {
      throw new ProductHostProtocolError(
        "product_apps_host_unavailable",
        "The CardBush Apps Product Host is not installed",
      );
    }
    return this.apps;
  }
  #mcp(): ProductMcpHost {
    if (!this.mcp) throw new ProductHostProtocolError("product_mcp_host_unavailable", "The Product MCP Host is not installed");
    return this.mcp;
  }
  #subagents(): ProductSubagentHost {
    if (!this.subagents) {
      throw new ProductHostProtocolError(
        "product_subagent_host_unavailable",
        "The Product Subagent Host is not installed",
      );
    }
    return this.subagents;
  }
}

export class ProductHostProtocolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ProductHostProtocolError";
  }
}

export function decodeProductHostCommand(input: unknown): ProductHostCommand {
  const value = record(input, "Product Host command must be an object");
  if (value.protocol !== PRODUCT_HOST_IPC_PROTOCOL) {
    throw new ProductHostProtocolError(
      "product_host_protocol_mismatch",
      `Expected ${PRODUCT_HOST_IPC_PROTOCOL}`,
    );
  }
  const kind = requiredString(value.kind, "kind");
  switch (kind) {
    case "models.get":
    case "apps.get":
    case "mcp.get":
    case "subagents.get":
    case "maintenance.clear_conversations":
    case "maintenance.clear_logs_cache":
    case "maintenance.runtime_assets.plan":
    case "maintenance.diagnostics":
      return { protocol: PRODUCT_HOST_IPC_PROTOCOL, kind };
    case "models.update":
      return {
        protocol: PRODUCT_HOST_IPC_PROTOCOL,
        kind,
        config: record(value.config, "config must be an object"),
      };
    case "apps.update":
    case "mcp.update":
      return {
        protocol: PRODUCT_HOST_IPC_PROTOCOL,
        kind,
        config: record(value.config, "config must be an object"),
      };
    case "model.resolve":
      return {
        protocol: PRODUCT_HOST_IPC_PROTOCOL,
        kind,
        modelId: requiredString(value.modelId, "modelId"),
      };
    case "maintenance.runtime_assets.reset": {
      if (value.confirm !== true) {
        throw new ProductHostProtocolError(
          "runtime_asset_reset_confirmation_required",
          "confirm=true is required to reset runtime assets",
        );
      }
      if (!Array.isArray(value.categories)) {
        throw new ProductHostProtocolError("invalid_product_host_command", "categories must be an array");
      }
      const categories = [...new Set(value.categories.map(String))];
      const known = new Set<RuntimeAssetCategory>([
        "prompts",
        "skills",
        "agent_profiles",
        "teams",
      ]);
      if (categories.some((item) => !known.has(item as RuntimeAssetCategory))) {
        throw new ProductHostProtocolError("invalid_product_host_command", "Unknown runtime asset category");
      }
      return {
        protocol: PRODUCT_HOST_IPC_PROTOCOL,
        kind,
        categories: categories as RuntimeAssetCategory[],
        confirm: true,
      };
    }
    default:
      throw new ProductHostProtocolError(
        "unknown_product_host_command",
        `Unknown Product Host command: ${kind}`,
      );
  }
}

function record(input: unknown, message: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ProductHostProtocolError("invalid_product_host_command", message);
  }
  return input as Record<string, unknown>;
}

function requiredString(input: unknown, field: string): string {
  const value = typeof input === "string" ? input.trim() : "";
  if (!value) {
    throw new ProductHostProtocolError("invalid_product_host_command", `${field} is required`);
  }
  return value;
}

function errorCode(error: unknown): string {
  if (error instanceof ProductHostProtocolError) {
    return error.code;
  }
  if (error && typeof error === "object" && "code" in error) {
    return String((error as { code: unknown }).code);
  }
  return "product_host_command_failed";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
