import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import { replaceFile, withConfigFileLock } from "./atomicFiles.js";
import { DEFAULT_SEARCH_RESULT_LIMIT, defaultPluginProxy, pluginProxySchema, searchResultLimitSchema, type PluginProxySettings } from '@cardbush/bush-protocol';

export const CARDBUSH_APPS_CONFIG_PROTOCOL = "cardbush.apps_config.v1" as const;

export type CardbushPluginComponentKind = "skill" | "mcp" | "app" | 'agent' | 'hook' | 'command' | 'runtime';

export interface CardbushPluginComponent {
  kind: CardbushPluginComponentKind;
  id: string;
  name: string;
  description: string;
  hook?: { definitionHash: string; definition: Record<string, unknown>; executable: boolean };
  runtime?: { settings: boolean };
  mcp?: { transport?: string; url?: string; registeredAppId?: string; required?: boolean };
  app?: { kind: 'url'; url: string } | { kind: 'renderer'; extensionId: string };
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
  authentication?: 'ON_INSTALL' | 'ON_USE';
  /** Absolute, validated directories containing this plugin's Skill packages. */
  skillRoots?: string[];
  /** Installed native extension identities, resolved from the package manifest. */
  runtimeExtensions?: string[];
  components: CardbushPluginComponent[];
}

export interface ComputerUsePluginConfig {
  screenshotDirectory: string;
  allowOpenApp: boolean;
  allowWindowClose: boolean;
  yieldToUser: boolean;
  restorePointer: boolean;
}

export interface ChromePluginConfig {
  connectionMode: "connector" | "remote_debugging";
}

export interface CardbushAppPluginConfig extends CardbushPluginCatalogEntry {
  installed: boolean;
  enabled: boolean;
  removalPending?: boolean;
  config: Record<string, unknown>;
}

export interface CardbushAppsConfigSnapshot {
  protocol: typeof CARDBUSH_APPS_CONFIG_PROTOCOL;
  revision: number;
  serviceEnabled: boolean;
  proxy: PluginProxySettings;
  searchResultLimit: number;
  plugins: CardbushAppPluginConfig[];
}

export interface CardbushAppsConfigStoreOptions {
  loadCatalog?: (excludedIds?: ReadonlySet<string>) => Promise<CardbushPluginCatalogEntry[]>;
}

const computerUseCatalogEntry: CardbushPluginCatalogEntry = {
  id: "computer-use",
  name: "Computer Use",
  description: "Observe and control Windows desktop applications.",
  longDescription: "A last-resort, cooperative desktop controller that yields to user activity, restores the pointer after mouse actions, and stops repeated-action loops.",
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
  readonly #loadCatalog: NonNullable<CardbushAppsConfigStoreOptions['loadCatalog']>;

  constructor(path: string, options: CardbushAppsConfigStoreOptions = {}) {
    if (!isAbsolute(path)) throw new Error("CardBush Apps config path must be absolute.");
    this.#path = resolve(path);
    this.#loadCatalog = options.loadCatalog ?? (() => Promise.resolve([computerUseCatalogEntry]));
  }

  get path(): string {
    return this.#path;
  }

  async read(): Promise<CardbushAppsConfigSnapshot> {
    return withConfigFileLock(this.#path, () => this.#read());
  }

  async #read(): Promise<CardbushAppsConfigSnapshot> {
    let stored;
    try {
      stored = JSON.parse(await readFile(this.#path, "utf8"));
    } catch (error) {
      if (isMissing(error)) return defaultCardbushAppsConfig(await this.#catalog());
      throw error;
    }
    // The existing configuration owns incomplete removals. Their package may
    // already be partly deleted; keep a disabled retry entry across restarts.
    const removals: CardbushAppPluginConfig[] = Array.isArray(stored.plugins)
      ? stored.plugins.filter((item: CardbushAppPluginConfig) => item?.removalPending === true && item.source === 'user') : [];
    const catalog = await this.#catalog(new Set(removals.map(item => item.id)));
    const snapshot = decodeSnapshot(stored, catalog);
    snapshot.plugins.push(...removals.map(item => ({ ...item, installed: true, enabled: false, removalPending: true })));
    return snapshot;
  }

  async write(input: unknown): Promise<CardbushAppsConfigSnapshot> {
    return withConfigFileLock(this.#path, () => this.#write(input));
  }

  async #write(input: unknown): Promise<CardbushAppsConfigSnapshot> {
    const existing = await this.#read();
    const expected = (input as { expectedRevision?: unknown })?.expectedRevision;
    if (expected !== undefined && expected !== existing.revision) throw new Error('Plugin configuration changed; refresh before saving again.');
    const snapshot = decodeUpdate(input, existing);
    return this.#persist(snapshot);
  }

  /** Suspend discovery during replacement, preserving configuration on either outcome. */
  async withPluginUpdate<T>(pluginId: string, replace: () => Promise<T>): Promise<T> {
    return withConfigFileLock(this.#path, async () => {
      const existing = await this.#read();
      const plugin = existing.plugins.find(item => item.id === pluginId);
      if (!plugin || plugin.source !== 'user') throw new Error('Installed user plugin not found. Refresh the list.');
      if (plugin.removalPending) throw new Error('Finish uninstalling this plugin before updating it.');
      const disabled = await this.#persist({ ...existing, revision: existing.revision + 1,
        plugins: existing.plugins.map(item => item.id === pluginId ? { ...item, enabled: false } : item) });
      try { return await replace(); }
      finally { await this.#persist({ ...existing, revision: disabled.revision + 1 }); }
    });
  }

  /** Keep the entry retryable until the host has stopped and removed its files. */
  async uninstall(pluginId: string, remove: (
    plugin: CardbushAppPluginConfig,
    commit: () => Promise<CardbushAppsConfigSnapshot>,
    otherPlugins: CardbushAppPluginConfig[],
  ) => Promise<CardbushAppsConfigSnapshot>): Promise<CardbushAppsConfigSnapshot> {
    return withConfigFileLock(this.#path, async () => {
      const existing = await this.#read();
      const plugin = existing.plugins.find(item => item.id === pluginId);
      if (!plugin) throw new Error('Plugin not found. Refresh the list.');
      if (plugin.source !== 'user') throw new Error('Bundled components can be disabled, not uninstalled.');
      const disabled = await this.#persist({ ...existing, revision: existing.revision + 1,
        plugins: existing.plugins.map(item => item.id === pluginId ? { ...item, installed: true, enabled: false, removalPending: true } : item) });
      return remove(plugin, () => this.#persist({ ...disabled, revision: disabled.revision + 1,
        plugins: disabled.plugins.filter(item => item.id !== pluginId) }), existing.plugins.filter(item => item.id !== pluginId));
    });
  }

  async #persist(snapshot: CardbushAppsConfigSnapshot): Promise<CardbushAppsConfigSnapshot> {
    await mkdir(dirname(this.#path), { recursive: true });
    const temporary = `${this.#path}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await replaceFile(temporary, this.#path);
    await chmod(this.#path, 0o600).catch(() => undefined);
    return snapshot;
  }

  async #catalog(excludedIds?: ReadonlySet<string>): Promise<CardbushPluginCatalogEntry[]> {
    const catalog = (await this.#loadCatalog(excludedIds)).filter(item => !excludedIds?.has(item.id));
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
    proxy: defaultPluginProxy(),
    searchResultLimit: DEFAULT_SEARCH_RESULT_LIMIT,
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
    proxy: pluginProxySchema.parse(value.proxy ?? existing.proxy),
    searchResultLimit: searchResultLimitSchema.parse(value.searchResultLimit === undefined ? existing.searchResultLimit : value.searchResultLimit),
    serviceEnabled: boolean(value.serviceEnabled, "serviceEnabled"),
    plugins: existing.plugins.map((plugin) => {
      const candidate = candidates.get(plugin.id);
      if (!candidate) return plugin;
      const installed = boolean(candidate.installed, "plugin.installed");
      if (plugin.removalPending && candidate.enabled === true) throw new Error('Finish uninstalling this plugin before reinstalling it.');
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
    proxy: pluginProxySchema.parse(value.proxy ?? defaultPluginProxy()),
    searchResultLimit: searchResultLimitSchema.default(DEFAULT_SEARCH_RESULT_LIMIT).parse(value.searchResultLimit),
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

/** Read the same persisted default without rescanning the plugin catalog on each search. */
export async function readCardbushSearchResultLimit(path?: string): Promise<number> {
  if (!path) return DEFAULT_SEARCH_RESULT_LIMIT;
  let text: string;
  try { text = await readFile(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_SEARCH_RESULT_LIMIT;
    throw error;
  }
  const value = record(JSON.parse(text), 'Stored CardBush Apps configuration must be an object.');
  if (value.protocol !== CARDBUSH_APPS_CONFIG_PROTOCOL || !Array.isArray(value.plugins)) {
    throw new Error('Stored CardBush Apps configuration has an unsupported schema.');
  }
  return searchResultLimitSchema.default(DEFAULT_SEARCH_RESULT_LIMIT).parse(value.searchResultLimit);
}

function defaultConfig(id: string): Record<string, unknown> {
  if (id === "computer-use") {
    return {
      screenshotDirectory: "",
      allowOpenApp: true,
      allowWindowClose: true,
      yieldToUser: true,
      restorePointer: true,
    };
  }
  if (id === "chrome") {
    return { connectionMode: "connector" } satisfies ChromePluginConfig;
  }
  return {};
}

function decodeConfig(id: string, input: unknown): Record<string, unknown> {
  const config = record(input ?? {}, "plugin.config must be an object.");
  const network = config.proxy === undefined ? {} : { proxy: pluginProxySchema.parse(config.proxy) };
  if (id === "computer-use") {
    const screenshotDirectory = optionalString(config.screenshotDirectory) ?? "";
    if (screenshotDirectory && !isAbsolute(screenshotDirectory)) {
      throw new Error("computer-use screenshotDirectory must be an absolute path or empty.");
    }
    return {
      ...network,
      screenshotDirectory,
      allowOpenApp: boolean(config.allowOpenApp, "computer-use.allowOpenApp"),
      allowWindowClose: boolean(config.allowWindowClose, "computer-use.allowWindowClose"),
      yieldToUser: optionalBoolean(config.yieldToUser, true),
      restorePointer: optionalBoolean(config.restorePointer, true),
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
      ...network,
      connectionMode: connectionMode === "remote_debugging"
        ? "remote_debugging"
        : "connector",
    } satisfies ChromePluginConfig;
  }
  return { ...structuredClone(config), ...network };
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

function optionalBoolean(input: unknown, fallback: boolean): boolean {
  return typeof input === "boolean" ? input : fallback;
}

function positiveInteger(input: unknown, field: string): number {
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${field} must be a positive integer.`);
  return value;
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
