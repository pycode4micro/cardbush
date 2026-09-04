import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import { replaceFile } from "./atomicFiles.js";

export const CARDBUSH_APPS_CONFIG_PROTOCOL = "cardbush.apps_config.v1" as const;

export type CardbushPluginComponentKind = "skill" | "mcp" | "app";

export interface CardbushPluginComponent {
  kind: CardbushPluginComponentKind;
  id: string;
  name: string;
  description: string;
}

export interface CardbushPluginCatalogEntry {
  id: string;
  name: string;
  description: string;
  longDescription: string;
  version: string;
  developerName: string;
  category: string;
  capabilities: string[];
  keywords: string[];
  defaultPrompts: string[];
  brandColor: string;
  logoPath: string;
  logoDarkPath: string;
  manifestPath: string;
  source: "bundled" | "user";
  installation: "AVAILABLE" | "INSTALLED_BY_DEFAULT";
  /** Absolute, validated directories containing this plugin's Skill packages. */
  skillRoots?: string[];
  components: CardbushPluginComponent[];
}

export interface ComputerUsePluginConfig {
  screenshotDirectory: string;
  allowOpenApp: boolean;
  allowWindowClose: boolean;
}

export interface ChromePluginConfig {
  connectionMode: "connector" | "remote_debugging";
}

export interface CardbushAppPluginConfig extends CardbushPluginCatalogEntry {
  installed: boolean;
  enabled: boolean;
  config: Record<string, unknown>;
}

export interface CardbushAppsConfigSnapshot {
  protocol: typeof CARDBUSH_APPS_CONFIG_PROTOCOL;
  revision: number;
  serviceEnabled: boolean;
  plugins: CardbushAppPluginConfig[];
}

export interface CardbushAppsConfigStoreOptions {
  loadCatalog?: () => Promise<CardbushPluginCatalogEntry[]>;
}

const computerUseCatalogEntry: CardbushPluginCatalogEntry = {
  id: "computer-use",
  name: "Computer Use",
  description: "Observe and control Windows desktop applications.",
  longDescription: "Computer Use observes and controls the local desktop through explicit, permission-aware actions. Input actions may occupy the user's mouse and keyboard.",
  version: "1.0.0",
  developerName: "CardBush",
  category: "Productivity",
  capabilities: ["Interactive", "Read", "Write"],
  keywords: ["desktop", "windows", "automation"],
  defaultPrompts: ["Inspect the current desktop", "Open an app and complete this task"],
  brandColor: "#8b7cf6",
  logoPath: "",
  logoDarkPath: "",
  manifestPath: "",
  source: "bundled",
  installation: "INSTALLED_BY_DEFAULT",
  components: [{
    kind: "mcp",
    id: "cardbush_apps",
    name: "Computer Use",
    description: "Permission-aware desktop control MCP tools.",
  }],
};

export class CardbushAppsConfigStore {
  readonly #path: string;
  readonly #loadCatalog: () => Promise<CardbushPluginCatalogEntry[]>;

  constructor(path: string, options: CardbushAppsConfigStoreOptions = {}) {
    if (!isAbsolute(path)) throw new Error("CardBush Apps config path must be absolute.");
    this.#path = resolve(path);
    this.#loadCatalog = options.loadCatalog ?? (() => Promise.resolve([computerUseCatalogEntry]));
  }

  get path(): string {
    return this.#path;
  }

  async read(): Promise<CardbushAppsConfigSnapshot> {
    const catalog = await this.#catalog();
    try {
      return decodeSnapshot(JSON.parse(await readFile(this.#path, "utf8")), catalog);
    } catch (error) {
      if (isMissing(error)) return defaultCardbushAppsConfig(catalog);
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

  async #catalog(): Promise<CardbushPluginCatalogEntry[]> {
    const catalog = await this.#loadCatalog();
    if (!catalog.length) throw new Error("CardBush plugin catalog is empty.");
    const ids = new Set<string>();
    for (const plugin of catalog) {
      if (!plugin.id || ids.has(plugin.id)) throw new Error(`Duplicate or empty CardBush plugin id: ${plugin.id}`);
      ids.add(plugin.id);
    }
    return catalog;
  }
}

export function defaultCardbushAppsConfig(
  catalog: CardbushPluginCatalogEntry[] = [computerUseCatalogEntry],
): CardbushAppsConfigSnapshot {
  return {
    protocol: CARDBUSH_APPS_CONFIG_PROTOCOL,
    revision: 1,
    serviceEnabled: true,
    plugins: catalog.map((entry) => ({
      ...entry,
      installed: entry.installation === "INSTALLED_BY_DEFAULT",
      enabled: entry.installation === "INSTALLED_BY_DEFAULT",
      config: defaultConfig(entry.id),
    })),
  };
}

function decodeUpdate(
  input: unknown,
  existing: CardbushAppsConfigSnapshot,
): CardbushAppsConfigSnapshot {
  const value = record(input, "CardBush Apps configuration must be an object.");
  if (!Array.isArray(value.plugins)) throw new Error("plugins must be an array.");
  const candidates = new Map(value.plugins.map((candidate) => {
    const item = record(candidate, "Plugin update must be an object.");
    return [normalizePluginId(requiredString(item.id, "plugin.id")), item] as const;
  }));
  const known = new Set(existing.plugins.map((plugin) => plugin.id));
  for (const id of candidates.keys()) {
    if (!known.has(id)) throw new Error(`Unknown CardBush plugin: ${id}`);
  }
  return {
    protocol: CARDBUSH_APPS_CONFIG_PROTOCOL,
    revision: existing.revision + 1,
    serviceEnabled: boolean(value.serviceEnabled, "serviceEnabled"),
    plugins: existing.plugins.map((plugin) => {
      const candidate = candidates.get(plugin.id);
      if (!candidate) return plugin;
      const installed = boolean(candidate.installed, "plugin.installed");
      return {
        ...plugin,
        installed,
        enabled: installed && boolean(candidate.enabled, "plugin.enabled"),
        config: decodeConfig(plugin.id, candidate.config ?? plugin.config),
      };
    }),
  };
}

function decodeSnapshot(
  input: unknown,
  catalog: CardbushPluginCatalogEntry[],
): CardbushAppsConfigSnapshot {
  const value = record(input, "Stored CardBush Apps configuration must be an object.");
  if (value.protocol !== CARDBUSH_APPS_CONFIG_PROTOCOL || !Array.isArray(value.plugins)) {
    throw new Error("Stored CardBush Apps configuration has an unsupported schema.");
  }
  const stored = new Map(value.plugins.map((candidate) => {
    const item = record(candidate, "Stored plugin state must be an object.");
    return [normalizePluginId(requiredString(item.id, "plugin.id")), item] as const;
  }));
  return {
    protocol: CARDBUSH_APPS_CONFIG_PROTOCOL,
    revision: positiveInteger(value.revision, "revision"),
    serviceEnabled: boolean(value.serviceEnabled, "serviceEnabled"),
    plugins: catalog.map((entry) => {
      const state = stored.get(entry.id);
      const installed = state
        ? boolean(state.installed, "plugin.installed")
        : entry.installation === "INSTALLED_BY_DEFAULT";
      return {
        ...entry,
        installed,
        enabled: installed && (state ? boolean(state.enabled, "plugin.enabled") : installed),
        config: decodeConfig(entry.id, state?.config ?? defaultConfig(entry.id)),
      };
    }),
  };
}

function defaultConfig(id: string): Record<string, unknown> {
  if (id === "computer-use") {
    return {
      screenshotDirectory: "",
      allowOpenApp: true,
      allowWindowClose: true,
    };
  }
  if (id === "chrome") {
    return { connectionMode: "connector" } satisfies ChromePluginConfig;
  }
  return {};
}

function decodeConfig(id: string, input: unknown): Record<string, unknown> {
  const config = record(input ?? {}, "plugin.config must be an object.");
  if (id === "computer-use") {
    const screenshotDirectory = optionalString(config.screenshotDirectory) ?? "";
    if (screenshotDirectory && !isAbsolute(screenshotDirectory)) {
      throw new Error("computer-use screenshotDirectory must be an absolute path or empty.");
    }
    return {
      screenshotDirectory,
      allowOpenApp: boolean(config.allowOpenApp, "computer-use.allowOpenApp"),
      allowWindowClose: boolean(config.allowWindowClose, "computer-use.allowWindowClose"),
    };
  }
  if (id === "chrome") {
    const connectionMode = optionalString(config.connectionMode);
    if (
      connectionMode &&
      connectionMode !== "managed" &&
      connectionMode !== "existing" &&
      connectionMode !== "connector" &&
      connectionMode !== "remote_debugging"
    ) {
      throw new Error("chrome.connectionMode must be connector or remote_debugging.");
    }
    // Older releases called both paths `managed` or `existing`. Migrate them
    // to the extension connector, which preserves the user's current profile
    // without relying on DevToolsActivePort.
    return {
      connectionMode: connectionMode === "remote_debugging"
        ? "remote_debugging"
        : "connector",
    } satisfies ChromePluginConfig;
  }
  return structuredClone(config);
}

function normalizePluginId(value: string): string {
  return value === "computer_use" ? "computer-use" : value;
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
