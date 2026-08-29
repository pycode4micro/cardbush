import type { BotPlatform } from "./botConfigStore.js";
import { BotConfigStore, botPlatformSpec } from "./botConfigStore.js";
import { BotSupervisor, BotSupervisorError } from "./botSupervisor.js";

export const PRODUCT_HOST_IPC_PROTOCOL = "cardbush.product_host_ipc.v1" as const;

export type ProductHostCommand =
  | { protocol: typeof PRODUCT_HOST_IPC_PROTOCOL; kind: "bots.list" }
  | { protocol: typeof PRODUCT_HOST_IPC_PROTOCOL; kind: "bot.config.get"; platform: BotPlatform }
  | {
      protocol: typeof PRODUCT_HOST_IPC_PROTOCOL;
      kind: "bot.config.update";
      platform: BotPlatform;
      config: Record<string, unknown>;
    }
  | { protocol: typeof PRODUCT_HOST_IPC_PROTOCOL; kind: "bot.status"; platform: BotPlatform }
  | {
      protocol: typeof PRODUCT_HOST_IPC_PROTOCOL;
      kind: "bot.service.control";
      platform: BotPlatform;
      action: "start" | "stop" | "restart";
    }
  | {
      protocol: typeof PRODUCT_HOST_IPC_PROTOCOL;
      kind: "bot.logs";
      platform: BotPlatform;
      tail?: number;
    }
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
  | { protocol: typeof PRODUCT_HOST_IPC_PROTOCOL; kind: "weixin.login.start" }
  | {
      protocol: typeof PRODUCT_HOST_IPC_PROTOCOL;
      kind: "session_link.create";
      sessionId: string;
      platform?: string;
      expiresSeconds: number;
    }
  | {
      protocol: typeof PRODUCT_HOST_IPC_PROTOCOL;
      kind: "weixin.login.status";
      loginId: string;
    }
  | {
      protocol: typeof PRODUCT_HOST_IPC_PROTOCOL;
      kind: "weixin.account.delete";
      accountId: string;
    };

export interface WeixinAccountHost {
  startLogin(): Promise<Record<string, unknown>>;
  loginStatus(loginId: string): Promise<Record<string, unknown>>;
  deleteAccount(accountId: string): Promise<Record<string, unknown>>;
}

export interface ProductModelHost {
  get(): Promise<Record<string, unknown>>;
  update(config: Record<string, unknown>): Promise<Record<string, unknown>>;
  resolve(modelId: string): Promise<Record<string, unknown>>;
}

export interface ProductSessionLinkHost {
  issue(input: {
    sessionId: string;
    platform?: string;
    expiresSeconds: number;
  }): Promise<Record<string, unknown>>;
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
    readonly config: BotConfigStore,
    readonly bots: BotSupervisor,
    readonly weixin?: WeixinAccountHost,
    readonly model?: ProductModelHost,
    readonly sessionLinks?: ProductSessionLinkHost,
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
      case "bots.list":
        return this.bots.listPayload();
      case "bot.config.get":
        return this.config.publicPayload(command.platform);
      case "bot.config.update":
        await this.config.write(command.platform, command.config);
        return this.config.publicPayload(command.platform);
      case "bot.status":
        return this.bots.status(command.platform);
      case "bot.service.control":
        if (command.action === "start") return this.bots.start(command.platform);
        if (command.action === "stop") return this.bots.stop(command.platform);
        return this.bots.restart(command.platform);
      case "bot.logs":
        return this.bots.logs(command.platform, command.tail);
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
      case "session_link.create":
        if (!this.sessionLinks) {
          throw new ProductHostProtocolError(
            "session_link_host_unavailable",
            "The Product Session Link Host is not installed",
          );
        }
        return this.sessionLinks.issue({
          sessionId: command.sessionId,
          ...(command.platform ? { platform: command.platform } : {}),
          expiresSeconds: command.expiresSeconds,
        });
      case "weixin.login.start":
        return this.#weixin().startLogin();
      case "weixin.login.status":
        return this.#weixin().loginStatus(command.loginId);
      case "weixin.account.delete":
        return this.#weixin().deleteAccount(command.accountId);
    }
  }

  #weixin(): WeixinAccountHost {
    if (!this.weixin) {
      throw new ProductHostProtocolError(
        "weixin_account_host_unavailable",
        "The Weixin account host is not installed",
      );
    }
    return this.weixin;
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
    case "bots.list":
    case "models.get":
    case "weixin.login.start":
      return { protocol: PRODUCT_HOST_IPC_PROTOCOL, kind };
    case "models.update":
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
    case "bot.config.get":
    case "bot.status":
      return { protocol: PRODUCT_HOST_IPC_PROTOCOL, kind, platform: platform(value.platform) };
    case "bot.config.update":
      return {
        protocol: PRODUCT_HOST_IPC_PROTOCOL,
        kind,
        platform: platform(value.platform),
        config: record(value.config, "config must be an object"),
      };
    case "bot.service.control": {
      const action = requiredString(value.action, "action");
      if (action !== "start" && action !== "stop" && action !== "restart") {
        throw new ProductHostProtocolError("invalid_product_host_command", "Invalid service action");
      }
      return { protocol: PRODUCT_HOST_IPC_PROTOCOL, kind, platform: platform(value.platform), action };
    }
    case "bot.logs": {
      const rawTail = value.tail;
      if (rawTail != null && (!Number.isInteger(rawTail) || Number(rawTail) <= 0)) {
        throw new ProductHostProtocolError("invalid_product_host_command", "tail must be a positive integer");
      }
      return {
        protocol: PRODUCT_HOST_IPC_PROTOCOL,
        kind,
        platform: platform(value.platform),
        ...(rawTail == null ? {} : { tail: Number(rawTail) }),
      };
    }
    case "weixin.login.status":
      return { protocol: PRODUCT_HOST_IPC_PROTOCOL, kind, loginId: requiredString(value.loginId, "loginId") };
    case "weixin.account.delete":
      return { protocol: PRODUCT_HOST_IPC_PROTOCOL, kind, accountId: requiredString(value.accountId, "accountId") };
    case "session_link.create": {
      const rawExpires = value.expiresSeconds;
      if (!Number.isInteger(rawExpires) || Number(rawExpires) < 60 || Number(rawExpires) > 86400) {
        throw new ProductHostProtocolError("invalid_product_host_command", "expiresSeconds must be between 60 and 86400");
      }
      const platform = typeof value.platform === "string" ? value.platform.trim().toLowerCase() : "";
      return {
        protocol: PRODUCT_HOST_IPC_PROTOCOL,
        kind,
        sessionId: requiredString(value.sessionId, "sessionId"),
        ...(platform ? { platform } : {}),
        expiresSeconds: Number(rawExpires),
      };
    }
    default:
      throw new ProductHostProtocolError(
        "unknown_product_host_command",
        `Unknown Product Host command: ${kind}`,
      );
  }
}

function platform(input: unknown): BotPlatform {
  const value = requiredString(input, "platform").toLowerCase();
  botPlatformSpec(value);
  return value as BotPlatform;
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
  if (error instanceof ProductHostProtocolError || error instanceof BotSupervisorError) {
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
