import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { replaceFile } from "./atomicFiles.js";

export const PRODUCT_MCP_CONFIG_PROTOCOL = "cardbush.product_mcp_config.v1" as const;

export interface ProductMcpConfigSnapshot {
  protocol: typeof PRODUCT_MCP_CONFIG_PROTOCOL;
  revision: number;
  servers: Array<Record<string, unknown>>;
}

export class ProductMcpConfigStore {
  readonly #path: string;
  constructor(path: string) {
    if (!isAbsolute(path)) throw new Error("Product MCP config path must be absolute.");
    this.#path = resolve(path);
  }
  async read(): Promise<ProductMcpConfigSnapshot> {
    try {
      return decode(JSON.parse(await readFile(this.#path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { protocol: PRODUCT_MCP_CONFIG_PROTOCOL, revision: 1, servers: [] };
      }
      throw error;
    }
  }
  async write(input: unknown): Promise<ProductMcpConfigSnapshot> {
    const value = input && typeof input === "object" && !Array.isArray(input)
      ? input as Record<string, unknown> : {};
    if (!Array.isArray(value.servers)) throw new Error("servers must be an array.");
    const before = await this.read();
    const next = decode({ protocol: PRODUCT_MCP_CONFIG_PROTOCOL, revision: before.revision + 1, servers: value.servers });
    await mkdir(dirname(this.#path), { recursive: true });
    const temp = `${this.#path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await replaceFile(temp, this.#path);
    await chmod(this.#path, 0o600).catch(() => undefined);
    return next;
  }
}

function decode(input: unknown): ProductMcpConfigSnapshot {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid Product MCP configuration.");
  const value = input as Record<string, unknown>;
  const revision = Number(value.revision);
  if (value.protocol !== PRODUCT_MCP_CONFIG_PROTOCOL || !Number.isSafeInteger(revision) || revision < 1 || !Array.isArray(value.servers)) throw new Error("Invalid Product MCP configuration.");
  return { protocol: PRODUCT_MCP_CONFIG_PROTOCOL, revision, servers: value.servers.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("MCP server configuration must be an object.");
    return structuredClone(item as Record<string, unknown>);
  }) };
}
