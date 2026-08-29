import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import { replaceFile } from "./atomicFiles.js";

export const CARDBUSH_APPS_CONFIG_PROTOCOL = "cardbush.apps_config.v1" as const;

export interface ComputerUsePluginConfig {
  screenshotDirectory: string;
  allowOpenApp: boolean;
  allowWindowClose: boolean;
}

export interface CardbushAppPluginConfig {
  id: "computer_use";
  name: string;
  description: string;
  installed: boolean;
  enabled: boolean;
  config: ComputerUsePluginConfig;
}

export interface CardbushAppsConfigSnapshot {
  protocol: typeof CARDBUSH_APPS_CONFIG_PROTOCOL;
  revision: number;
  serviceEnabled: boolean;
  plugins: CardbushAppPluginConfig[];
}

export class CardbushAppsConfigStore {
  readonly #path: string;

  constructor(path: string) {
    if (!isAbsolute(path)) throw new Error("CardBush Apps config path must be absolute.");
    this.#path = resolve(path);
  }

  get path(): string {
    return this.#path;
  }

  async read(): Promise<CardbushAppsConfigSnapshot> {
    try {
      return decodeSnapshot(JSON.parse(await readFile(this.#path, "utf8")));
    } catch (error) {
      if (isMissing(error)) return defaultCardbushAppsConfig();
      throw error;
    }
  }

  async write(input: unknown): Promise<CardbushAppsConfigSnapshot> {
    const existing = await this.read();
    const snapshot = decodeUpdate(input, existing);
    await mkdir(dirname(this.#path), { recursive: true });
    const temporary = `${this.#path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await replaceFile(temporary, this.#path);
    await chmod(this.#path, 0o600).catch(() => undefined);
    return snapshot;
  }
}

export function defaultCardbushAppsConfig(): CardbushAppsConfigSnapshot {
  return {
    protocol: CARDBUSH_APPS_CONFIG_PROTOCOL,
    revision: 1,
    serviceEnabled: true,
    plugins: [{
      id: "computer_use",
      name: "Computer Use",
      description: "Observe and interact with the local Windows desktop.",
      installed: true,
      enabled: true,
      config: {
        screenshotDirectory: "",
        allowOpenApp: true,
        allowWindowClose: true,
      },
    }],
  };
}

function decodeUpdate(
  input: unknown,
  existing: CardbushAppsConfigSnapshot,
): CardbushAppsConfigSnapshot {
  const value = record(input, "CardBush Apps configuration must be an object.");
  if (!Array.isArray(value.plugins)) throw new Error("plugins must be an array.");
  const existingById = new Map(existing.plugins.map((plugin) => [plugin.id, plugin]));
  const plugins = value.plugins.map((candidate) => decodePlugin(candidate, existingById));
  ensureCatalog(plugins);
  return {
    protocol: CARDBUSH_APPS_CONFIG_PROTOCOL,
    revision: existing.revision + 1,
    serviceEnabled: boolean(value.serviceEnabled, "serviceEnabled"),
    plugins,
  };
}

function decodeSnapshot(input: unknown): CardbushAppsConfigSnapshot {
  const value = record(input, "Stored CardBush Apps configuration must be an object.");
  if (value.protocol !== CARDBUSH_APPS_CONFIG_PROTOCOL || !Array.isArray(value.plugins)) {
    throw new Error("Stored CardBush Apps configuration has an unsupported schema.");
  }
  const plugins = value.plugins.map((candidate) => decodePlugin(candidate));
  ensureCatalog(plugins);
  return {
    protocol: CARDBUSH_APPS_CONFIG_PROTOCOL,
    revision: positiveInteger(value.revision, "revision"),
    serviceEnabled: boolean(value.serviceEnabled, "serviceEnabled"),
    plugins,
  };
}

function decodePlugin(
  input: unknown,
  existingById = new Map<CardbushAppPluginConfig["id"], CardbushAppPluginConfig>(),
): CardbushAppPluginConfig {
  const value = record(input, "CardBush App plugin configuration must be an object.");
  const id = requiredString(value.id, "plugin.id");
  if (id !== "computer_use") throw new Error(`Unknown CardBush App plugin: ${id}`);
  const existing = existingById.get(id);
  const config = record(value.config ?? existing?.config ?? {}, "plugin.config must be an object.");
  const screenshotDirectory = optionalString(config.screenshotDirectory) ?? "";
  if (screenshotDirectory && !isAbsolute(screenshotDirectory)) {
    throw new Error("computer_use screenshotDirectory must be an absolute path or empty.");
  }
  return {
    id,
    name: existing?.name ?? "Computer Use",
    description: existing?.description ?? "Observe and interact with the local Windows desktop.",
    installed: boolean(value.installed, "plugin.installed"),
    enabled: boolean(value.enabled, "plugin.enabled"),
    config: {
      screenshotDirectory,
      allowOpenApp: boolean(config.allowOpenApp, "computer_use.allowOpenApp"),
      allowWindowClose: boolean(config.allowWindowClose, "computer_use.allowWindowClose"),
    },
  };
}

function ensureCatalog(plugins: CardbushAppPluginConfig[]): void {
  if (plugins.length !== 1 || plugins[0]?.id !== "computer_use") {
    throw new Error("CardBush Apps configuration must contain the complete bundled plugin catalog.");
  }
}

function record(input: unknown, message: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(message);
  return input as Record<string, unknown>;
}

function requiredString(input: unknown, field: string): string {
  const value = optionalString(input);
  if (!value) throw new Error(`${field} is required.`);
  return value;
}

function optionalString(input: unknown): string | undefined {
  const value = typeof input === "string" ? input.trim() : "";
  return value || undefined;
}

function boolean(input: unknown, field: string): boolean {
  if (typeof input !== "boolean") throw new Error(`${field} must be a boolean.`);
  return input;
}

function positiveInteger(input: unknown, field: string): number {
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${field} must be a positive integer.`);
  return value;
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
