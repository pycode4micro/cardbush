import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { replaceFile } from "./atomicFiles.js";

export type BotPlatform = "weixin" | "feishu" | "telegram" | "discord";

export interface BotPlatformSpec {
  platform: BotPlatform;
  displayName: string;
  supported: boolean;
  defaults: Record<string, unknown>;
  secretFields: readonly string[];
  requiredFields: readonly string[];
}

const MASK_PREFIX = "••••";
const sharedDefaults = {
  enabled: false,
  project_dir: "",
  permission_mode: "task_free",
  disabled_tools: ["computer_use"],
  allowed_skills: [],
  allowed_user_ids: [],
  allowed_channel_ids: [],
  subagent_enabled: true,
};

export const botPlatformSpecs: Record<BotPlatform, BotPlatformSpec> = {
  weixin: {
    platform: "weixin",
    displayName: "WeChat",
    supported: true,
    defaults: {
      ...sharedDefaults,
      api_base: "https://ilinkai.weixin.qq.com",
      login_api_base: "https://ilinkai.weixin.qq.com",
      app_id: "bot",
      app_version: "2.1.7",
      bot_type: "3",
      route_tag: "",
      poll_timeout_seconds: 35,
      api_timeout_seconds: 15,
      login_timeout_seconds: 480,
      proxy: "",
      no_proxy: "",
      disable_env_proxy: true,
      unsupported_message_text: "当前仅支持文本消息。",
    },
    secretFields: [],
    requiredFields: [],
  },
  feishu: {
    platform: "feishu",
    displayName: "Feishu",
    supported: true,
    defaults: {
      ...sharedDefaults,
      app_id: "",
      app_secret: "",
      verification_token: "",
      encrypt_key: "",
      api_base: "https://open.feishu.cn",
      host: "127.0.0.1",
      port: 8091,
      mode: "long",
      ack_mode: "reaction",
      ack_reaction_emoji: "OK",
      ack_placeholder_text: "⏳ 正在思考中...",
      disable_env_proxy: true,
    },
    secretFields: ["app_secret", "verification_token", "encrypt_key"],
    requiredFields: ["app_id", "app_secret"],
  },
  telegram: {
    platform: "telegram",
    displayName: "Telegram",
    supported: true,
    defaults: {
      ...sharedDefaults,
      bot_token: "",
      api_base: "https://api.telegram.org",
      poll_timeout_seconds: 35,
      api_timeout_seconds: 15,
    },
    secretFields: ["bot_token"],
    requiredFields: ["bot_token"],
  },
  discord: {
    platform: "discord",
    displayName: "Discord",
    supported: true,
    defaults: {
      ...sharedDefaults,
      application_id: "",
      bot_token: "",
      public_key: "",
      api_base: "https://discord.com/api/v10",
      command_name: "chat",
      host: "127.0.0.1",
      port: 8092,
      guild_id: "",
      mode: "long",
      gateway_intents: 37377,
    },
    secretFields: ["bot_token", "public_key"],
    requiredFields: ["application_id", "bot_token"],
  },
};

export class BotConfigError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "BotConfigError";
  }
}

interface ConfigDocument {
  version: 1;
  platforms: Partial<Record<BotPlatform, Record<string, unknown>>>;
}

export class BotConfigStore {
  readonly #path: string;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.#path = resolve(path);
  }

  async read(platform: BotPlatform): Promise<Record<string, unknown>> {
    const spec = botPlatformSpec(platform);
    const configured = structuredClone(spec.defaults);
    const saved = (await this.#document()).platforms[platform];
    if (saved) {
      for (const [key, value] of Object.entries(saved)) {
        if (key in spec.defaults) configured[key] = structuredClone(value);
      }
    }
    return configured;
  }

  async write(
    platform: BotPlatform,
    update: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    let result: Record<string, unknown> | undefined;
    const operation = this.#writeQueue.then(async () => {
      result = await this.#write(platform, update);
    });
    this.#writeQueue = operation.catch(() => undefined);
    await operation;
    return structuredClone(result!);
  }

  async publicPayload(platform: BotPlatform): Promise<Record<string, unknown>> {
    const spec = botPlatformSpec(platform);
    const config = await this.read(platform);
    const publicConfig = structuredClone(config);
    const secrets: Record<string, unknown> = {};
    for (const key of spec.secretFields) {
      const value = config[key];
      secrets[key] = { configured: Boolean(value), masked: mask(value) };
      publicConfig[key] = mask(value);
    }
    return {
      protocol: "cardbush.product_bot_config.v1",
      platform,
      enabled: Boolean(config.enabled),
      configured: this.missingRequiredFields(platform, config).length === 0,
      config: publicConfig,
      secrets,
      required_fields: [...spec.requiredFields],
      missing_required_fields: this.missingRequiredFields(platform, config),
    };
  }

  missingRequiredFields(
    platform: BotPlatform,
    config?: Record<string, unknown>,
  ): string[] {
    const spec = botPlatformSpec(platform);
    if (!spec.supported) return ["adapter_package"];
    const values = config ?? spec.defaults;
    const missing = spec.requiredFields.filter((key) => !values[key]);
    if (platform === "discord" && values.mode === "webhook" && !values.public_key) {
      missing.push("public_key");
    }
    return missing;
  }

  async #document(): Promise<ConfigDocument> {
    let source: string;
    try {
      source = await readFile(this.#path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, platforms: {} };
      }
      throw new BotConfigError(
        "bot_config_unreadable",
        `Cannot read bot configuration: ${errorMessage(error)}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch (error) {
      throw new BotConfigError(
        "bot_config_invalid_json",
        `Bot configuration is not valid JSON: ${errorMessage(error)}`,
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new BotConfigError("bot_config_invalid", "Bot configuration root must be an object");
    }
    const platforms = (parsed as Record<string, unknown>).platforms;
    if (!platforms || typeof platforms !== "object" || Array.isArray(platforms)) {
      throw new BotConfigError("bot_config_invalid", "Bot configuration must contain `platforms`");
    }
    return { version: 1, platforms: platforms as ConfigDocument["platforms"] };
  }

  async #write(
    platform: BotPlatform,
    update: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const spec = botPlatformSpec(platform);
    const unknown = Object.keys(update).filter((key) => !(key in spec.defaults)).sort();
    if (unknown.length) {
      throw new BotConfigError(
        "invalid_bot_config",
        `Unsupported ${platform} config field(s): ${unknown.join(", ")}`,
      );
    }
    const document = await this.#document();
    const current = structuredClone(spec.defaults);
    const saved = document.platforms[platform];
    if (saved) {
      for (const [key, value] of Object.entries(saved)) {
        if (key in spec.defaults) current[key] = structuredClone(value);
      }
    }
    applyUpdate(spec, current, update);
    document.platforms[platform] = current;
    await mkdir(dirname(this.#path), { recursive: true });
    const temporary = `${this.#path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    await replaceFile(temporary, this.#path);
    return structuredClone(current);
  }
}

export function botPlatformSpec(platform: string): BotPlatformSpec {
  if (!(platform in botPlatformSpecs)) {
    throw new BotConfigError("unknown_bot_platform", `Unknown bot platform: ${platform}`);
  }
  return botPlatformSpecs[platform as BotPlatform];
}

function applyUpdate(
  spec: BotPlatformSpec,
  current: Record<string, unknown>,
  update: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(update)) {
    if (spec.secretFields.includes(key)) {
      if (isMasked(value) || value === "") continue;
      current[key] = value == null ? "" : String(value);
    } else if (key === "enabled" || key === "subagent_enabled") {
      if (typeof value !== "boolean") {
        throw new BotConfigError("invalid_bot_config", `\`${key}\` must be a JSON boolean`);
      }
      current[key] = value;
    } else if (["allowed_user_ids", "allowed_channel_ids", "disabled_tools", "allowed_skills"].includes(key)) {
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        throw new BotConfigError("invalid_bot_config", `\`${key}\` must be a JSON array of strings`);
      }
      current[key] = [...new Set(value.map((item) => item.trim()).filter(Boolean))];
    } else if (key === "permission_mode") {
      const mode = String(value ?? "").trim().toLowerCase();
      if (!["task_free", "user_free", "all_free"].includes(mode)) {
        throw new BotConfigError(
          "invalid_bot_config",
          "`permission_mode` must be task_free, user_free, or all_free",
        );
      }
      current[key] = mode;
    } else {
      current[key] = structuredClone(value);
    }
  }
}

function mask(value: unknown): string {
  const text = String(value ?? "");
  if (!text) return "";
  return text.length > 4 ? `${MASK_PREFIX}${text.slice(-4)}` : MASK_PREFIX;
}

function isMasked(value: unknown): boolean {
  return String(value ?? "").startsWith(MASK_PREFIX);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
