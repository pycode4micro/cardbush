import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  CARDBUSH_SUBAGENT_CONFIG_PROTOCOL,
  DEFAULT_CHILD_AGENT_DISABLED_TOOLS,
  type ChildAgentConfiguration,
  type ChildAgentModelPolicy,
} from "@cardbush/bush-protocol";

import { replaceFile } from "./atomicFiles.js";

export { CARDBUSH_SUBAGENT_CONFIG_PROTOCOL } from "@cardbush/bush-protocol";
export const DEFAULT_SUBAGENT_DISABLED_TOOLS = DEFAULT_CHILD_AGENT_DISABLED_TOOLS;
export type ProductSubagentModelPolicy = ChildAgentModelPolicy;
export type ProductSubagentConfig = ChildAgentConfiguration;

export function defaultProductSubagentConfig(): ProductSubagentConfig {
  return {
    protocol: CARDBUSH_SUBAGENT_CONFIG_PROTOCOL,
    permissionRouting: "user",
    childPermissionMode: "task_free",
    model: { mode: "inherit" },
    disabledTools: [...DEFAULT_SUBAGENT_DISABLED_TOOLS],
  };
}

export class ProductSubagentConfigStore {
  readonly #path: string;

  constructor(path: string) {
    if (!isAbsolute(path)) throw new Error("Product Subagent config path must be absolute.");
    this.#path = resolve(path);
  }

  async read(): Promise<ProductSubagentConfig> {
    try {
      const raw = JSON.parse(await readFile(this.#path, "utf8"));
      const decoded = decodeProductSubagentConfig(raw);
      if (JSON.stringify(raw) !== JSON.stringify(decoded)) await this.#write(decoded);
      return decoded;
    } catch (error) {
      if (!isMissing(error)) throw error;
      const fallback = defaultProductSubagentConfig();
      await this.#write(fallback);
      return fallback;
    }
  }

  async #write(config: ProductSubagentConfig): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    const temp = `${this.#path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await replaceFile(temp, this.#path);
    await chmod(this.#path, 0o600).catch(() => undefined);
  }
}

export function decodeProductSubagentConfig(input: unknown): ProductSubagentConfig {
  const fallback = defaultProductSubagentConfig();
  const value = record(input, "Subagent configuration must be an object.");
  const known = new Set([
    "protocol",
    "permissionRouting",
    "childPermissionMode",
    "model",
    "disabledTools",
  ]);
  const unexpected = Object.keys(value).filter((key) => !known.has(key));
  if (unexpected.length > 0) {
    throw new Error(`Unsupported Subagent config fields: ${unexpected.join(", ")}.`);
  }
  if (
    value.protocol !== undefined &&
    value.protocol !== CARDBUSH_SUBAGENT_CONFIG_PROTOCOL
  ) {
    throw new Error(`Unsupported Subagent config protocol: ${String(value.protocol)}.`);
  }
  const permissionRouting = value.permissionRouting ?? fallback.permissionRouting;
  if (permissionRouting !== "user" && permissionRouting !== "parent") {
    throw new Error("Subagent permissionRouting must be user or parent.");
  }
  const childPermissionMode = value.childPermissionMode ?? fallback.childPermissionMode;
  if (!["task_free", "user_free", "all_free"].includes(String(childPermissionMode))) {
    throw new Error(
      "Subagent childPermissionMode must be task_free, user_free, or all_free.",
    );
  }
  const disabledTools = value.disabledTools === undefined
    ? fallback.disabledTools
    : stringArray(value.disabledTools, "disabledTools");
  return {
    protocol: CARDBUSH_SUBAGENT_CONFIG_PROTOCOL,
    permissionRouting,
    childPermissionMode: childPermissionMode as ProductSubagentConfig["childPermissionMode"],
    model: decodeModelPolicy(value.model ?? fallback.model),
    disabledTools: [...new Set(disabledTools)],
  };
}

function decodeModelPolicy(input: unknown): ProductSubagentModelPolicy {
  const value = record(input, "Subagent model policy must be an object.");
  const unexpected = Object.keys(value).filter((key) => key !== "mode" && key !== "modelId");
  if (unexpected.length > 0) {
    throw new Error(`Unsupported Subagent model fields: ${unexpected.join(", ")}.`);
  }
  if (value.mode === "inherit") {
    if (value.modelId !== undefined) throw new Error("Inherited Subagent model cannot set modelId.");
    return { mode: "inherit" };
  }
  if (value.mode === "fixed") {
    const modelId = requiredString(value.modelId, "model.modelId");
    return { mode: "fixed", modelId };
  }
  throw new Error("Subagent model.mode must be inherit or fixed.");
}

function stringArray(input: unknown, field: string): string[] {
  if (!Array.isArray(input)) throw new Error(`${field} must be an array.`);
  return input.map((item) => requiredString(item, field));
}

function record(input: unknown, message: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(message);
  return input as Record<string, unknown>;
}

function requiredString(input: unknown, field: string): string {
  const value = typeof input === "string" ? input.trim() : "";
  if (!value) throw new Error(`${field} must be a non-empty string.`);
  return value;
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error &&
    (error as { code?: unknown }).code === "ENOENT");
}
