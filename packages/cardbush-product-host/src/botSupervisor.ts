import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  BotConfigError,
  BotConfigStore,
  botPlatformSpec,
  botPlatformSpecs,
  type BotPlatform,
} from "./botConfigStore.js";
import type { BotDeliveryRequest, BotDeliveryResult } from "./conversation.js";

export type BotServiceStatus =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "failed";

export interface BotRuntimeStatus {
  healthStatus?: string;
  errorCode?: string;
  lastError?: string;
  requiresReauthentication?: boolean;
  accounts?: Array<Record<string, unknown>>;
}

export interface BotAdapterContext {
  platform: BotPlatform;
  config: Readonly<Record<string, unknown>>;
  dataDir: string;
  signal: AbortSignal;
  log(level: "debug" | "info" | "warning" | "error", message: string): Promise<void>;
}

export interface BotAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
  status?(): BotRuntimeStatus | Promise<BotRuntimeStatus>;
  deliver?(request: BotDeliveryRequest): Promise<BotDeliveryResult>;
}

export type BotAdapterFactory = (context: BotAdapterContext) => BotAdapter;

export class BotSupervisorError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "BotSupervisorError";
  }
}

interface ManagedBotState {
  serviceStatus: BotServiceStatus;
  startedAt?: string;
  stoppedAt?: string;
  lastError: string;
  adapter?: BotAdapter;
  controller?: AbortController;
}

export class BotSupervisor {
  readonly #config: BotConfigStore;
  readonly #dataDir: string;
  readonly #factories: Partial<Record<BotPlatform, BotAdapterFactory>>;
  readonly #states = new Map<BotPlatform, ManagedBotState>();
  readonly #queues = new Map<BotPlatform, Promise<void>>();
  #closed = false;

  constructor(input: {
    configStore: BotConfigStore;
    dataDir: string;
    adapterFactories?: Partial<Record<BotPlatform, BotAdapterFactory>>;
  }) {
    this.#config = input.configStore;
    this.#dataDir = resolve(input.dataDir);
    this.#factories = { ...input.adapterFactories };
    for (const platform of Object.keys(botPlatformSpecs) as BotPlatform[]) {
      this.#states.set(platform, { serviceStatus: "stopped", lastError: "" });
      this.#queues.set(platform, Promise.resolve());
    }
  }

  async startup(): Promise<void> {
    this.#closed = false;
    await mkdir(join(this.#dataDir, "logs", "bots"), { recursive: true });
    const enabled = await Promise.all(
      (Object.keys(botPlatformSpecs) as BotPlatform[]).map(async (platform) => ({
        platform,
        enabled: Boolean((await this.#config.read(platform)).enabled),
      })),
    );
    await Promise.allSettled(
      enabled.filter((item) => item.enabled).map((item) => this.start(item.platform)),
    );
  }

  async shutdown(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled(
      (Object.keys(botPlatformSpecs) as BotPlatform[]).map((platform) => this.stop(platform)),
    );
  }

  async listPayload(): Promise<Record<string, unknown>> {
    return {
      protocol: "cardbush.product_bots.v1",
      bots: await Promise.all(
        (Object.keys(botPlatformSpecs) as BotPlatform[]).map((platform) => this.overview(platform)),
      ),
    };
  }

  async overview(platform: BotPlatform): Promise<Record<string, unknown>> {
    const status = await this.status(platform);
    return pick(status, [
      "platform", "display_name", "enabled", "configured", "service_status",
      "account_count", "last_error", "missing_required_fields", "health_status",
      "error_code", "requires_reauthentication",
    ]);
  }

  async status(platform: BotPlatform): Promise<Record<string, unknown>> {
    const spec = botPlatformSpec(platform);
    const state = this.#state(platform);
    const config = await this.#config.read(platform);
    const missing = this.#config.missingRequiredFields(platform, config);
    let runtime: BotRuntimeStatus = {};
    if (state.adapter?.status) {
      try {
        runtime = await state.adapter.status();
      } catch (error) {
        await this.#log(platform, "error", `status failed: ${errorMessage(error)}`);
      }
    }
    const accounts = runtime.accounts ?? [];
    return {
      protocol: "cardbush.product_bot_status.v1",
      platform,
      display_name: spec.displayName,
      enabled: Boolean(config.enabled),
      configured: missing.length === 0,
      service_status: state.serviceStatus,
      started_at: state.startedAt ?? null,
      stopped_at: state.stoppedAt ?? null,
      log_path: this.#logPath(platform),
      account_count: accounts.length,
      accounts,
      last_error: runtime.lastError ?? state.lastError,
      missing_required_fields: missing,
      health_status: runtime.healthStatus ?? (
        state.serviceStatus === "running" ? "healthy" : state.serviceStatus
      ),
      error_code: runtime.errorCode ?? "",
      requires_reauthentication: runtime.requiresReauthentication ?? false,
    };
  }

  start(platform: BotPlatform): Promise<Record<string, unknown>> {
    return this.#serialize(platform, async () => {
      if (this.#closed) {
        throw new BotSupervisorError("product_host_closed", "Product Host is shutting down");
      }
      const state = this.#state(platform);
      if (state.serviceStatus === "running") return this.status(platform);
      const config = await this.#config.read(platform);
      if (!config.enabled) {
        throw new BotSupervisorError("bot_disabled", `${platform} bot is disabled`);
      }
      const missing = this.#config.missingRequiredFields(platform, config);
      if (missing.length) {
        throw new BotSupervisorError(
          "bot_not_configured",
          `Missing required field(s): ${missing.join(", ")}`,
        );
      }
      const factory = this.#factories[platform];
      if (!factory) {
        throw new BotSupervisorError(
          "bot_adapter_unavailable",
          `${platform} adapter is not installed in this Product Host`,
        );
      }
      state.serviceStatus = "starting";
      state.lastError = "";
      const controller = new AbortController();
      const adapter = factory({
        platform,
        config: Object.freeze(structuredClone(config)),
        dataDir: join(this.#dataDir, platform),
        signal: controller.signal,
        log: (level, message) => this.#log(platform, level, message),
      });
      state.controller = controller;
      state.adapter = adapter;
      try {
        await adapter.start();
        state.serviceStatus = "running";
        state.startedAt = now();
        state.stoppedAt = undefined;
        await this.#log(platform, "info", "adapter started");
      } catch (error) {
        controller.abort();
        state.adapter = undefined;
        state.controller = undefined;
        state.serviceStatus = "failed";
        state.stoppedAt = now();
        state.lastError = errorMessage(error);
        await this.#log(platform, "error", `adapter start failed: ${state.lastError}`);
        throw new BotSupervisorError("bot_start_failed", state.lastError);
      }
      return this.status(platform);
    });
  }

  stop(platform: BotPlatform): Promise<Record<string, unknown>> {
    return this.#serialize(platform, async () => {
      const state = this.#state(platform);
      const adapter = state.adapter;
      if (!adapter) {
        state.serviceStatus = "stopped";
        state.stoppedAt ??= now();
        return this.status(platform);
      }
      state.serviceStatus = "stopping";
      state.controller?.abort();
      try {
        await adapter.stop();
        state.serviceStatus = "stopped";
        state.lastError = "";
        await this.#log(platform, "info", "adapter stopped");
      } catch (error) {
        state.serviceStatus = "failed";
        state.lastError = errorMessage(error);
        await this.#log(platform, "error", `adapter stop failed: ${state.lastError}`);
      } finally {
        state.adapter = undefined;
        state.controller = undefined;
        state.stoppedAt = now();
      }
      return this.status(platform);
    });
  }

  async restart(platform: BotPlatform): Promise<Record<string, unknown>> {
    await this.stop(platform);
    return this.start(platform);
  }

  async logs(platform: BotPlatform, tail = 200): Promise<Record<string, unknown>> {
    botPlatformSpec(platform);
    const bounded = Math.max(1, Math.min(Math.trunc(tail), 5000));
    let lines: string[] = [];
    try {
      lines = (await readFile(this.#logPath(platform), "utf8")).split(/\r?\n/).filter(Boolean);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return {
      protocol: "cardbush.product_bot_logs.v1",
      platform,
      lines: lines.slice(-bounded).map((line) => redactLogLine(line)),
    };
  }

  async deliver(platform: BotPlatform, request: BotDeliveryRequest): Promise<BotDeliveryResult> {
    const state = this.#state(platform);
    if (state.serviceStatus !== "running" || !state.adapter) {
      throw new BotSupervisorError("bot_not_running", `${platform} bot is not running`);
    }
    if (!state.adapter.deliver) {
      throw new BotSupervisorError(
        "bot_delivery_unavailable",
        `${platform} adapter does not support file delivery`,
      );
    }
    return state.adapter.deliver(request);
  }

  #serialize<T>(platform: BotPlatform, action: () => Promise<T>): Promise<T> {
    botPlatformSpec(platform);
    const previous = this.#queues.get(platform) ?? Promise.resolve();
    const operation = previous.then(action, action);
    this.#queues.set(platform, operation.then(() => undefined, () => undefined));
    return operation;
  }

  #state(platform: BotPlatform): ManagedBotState {
    const state = this.#states.get(platform);
    if (!state) throw new BotConfigError("unknown_bot_platform", `Unknown platform: ${platform}`);
    return state;
  }

  #logPath(platform: BotPlatform): string {
    return join(this.#dataDir, "logs", "bots", `${platform}.jsonl`);
  }

  async #log(
    platform: BotPlatform,
    level: "debug" | "info" | "warning" | "error",
    message: string,
  ): Promise<void> {
    const path = this.#logPath(platform);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify({ at: now(), level, message })}\n`, "utf8");
  }
}

function now(): string {
  return new Date().toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pick(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((key) => [key, source[key]]));
}

function redactLogLine(line: string): string {
  return line.replace(
    /((?:token|secret|authorization|api[_-]?key)["'=:\s]+)([^\s",}]+)/gi,
    "$1••••",
  );
}
