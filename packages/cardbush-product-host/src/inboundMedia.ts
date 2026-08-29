import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { replaceFile } from "./atomicFiles.js";

export interface InboundMedia {
  path: string;
  kind: "image" | "file";
  mediaType?: string;
  name: string;
}

export async function downloadInboundMedia(input: {
  url: string;
  directory: string;
  name?: string;
  mediaType?: string;
  headers?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  maxBytes?: number;
}): Promise<InboundMedia> {
  const url = new URL(input.url);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Inbound media URL must use HTTP or HTTPS.");
  }
  const response = await (input.fetch ?? globalThis.fetch)(url, {
    headers: input.headers,
    signal: input.signal,
  });
  if (!response.ok) throw new Error(`Inbound media download failed (${response.status}).`);
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  const maxBytes = input.maxBytes ?? 50 * 1024 * 1024;
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`Inbound media exceeds ${maxBytes} bytes.`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) throw new Error("Inbound media download returned an empty file.");
  if (bytes.length > maxBytes) throw new Error(`Inbound media exceeds ${maxBytes} bytes.`);
  const mediaType = normalizedMediaType(input.mediaType || response.headers.get("content-type"));
  const name = safeName(input.name || basename(url.pathname) || "attachment", mediaType);
  await mkdir(input.directory, { recursive: true });
  const target = join(input.directory, `${crypto.randomUUID()}-${name}`);
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { flag: "wx" });
  await replaceFile(temporary, target);
  return {
    path: target,
    kind: mediaType.startsWith("image/") ? "image" : "file",
    ...(mediaType ? { mediaType } : {}),
    name,
  };
}

function normalizedMediaType(value: string | null | undefined): string {
  return String(value ?? "").split(";", 1)[0]!.trim().toLowerCase();
}

function safeName(value: string, mediaType: string): string {
  const source = basename(value).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  const fallbackExtension = extensionForMediaType(mediaType);
  const name = source && source !== "." && source !== ".." ? source : `attachment${fallbackExtension}`;
  return extname(name) || !fallbackExtension ? name : `${name}${fallbackExtension}`;
}

function extensionForMediaType(value: string): string {
  return ({
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/bmp": ".bmp",
  } as Record<string, string>)[value] ?? "";
}
