import { readFile, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, relative } from 'node:path';
import { withinPackage } from './pluginPackagePaths';

export interface RuntimePluginPackage {
  id: string;
  apiVersion: 1;
  entry: string;
  renderer?: string;
}

/** Native extensions are executable packages, just like installed stdio services. */
export async function resolveRuntimePluginPackage(root: string, manifest: Record<string, unknown>): Promise<RuntimePluginPackage | undefined> {
  const cardbush = manifest.cardbush as Record<string, unknown> | undefined;
  const raw = cardbush?.runtimeExtension;
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Runtime extensions require a packaged entry and apiVersion; compiled extension names are no longer supported. Reinstall the plugin.');
  const value = raw as Record<string, unknown>;
  if (value.apiVersion !== 1) throw new Error(`Unsupported plugin Runtime API version: ${String(value.apiVersion)}.`);
  const id = String(manifest.name ?? '');
  if (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(id)) throw new Error('Invalid Runtime plugin identity.');
  const base = await realpath(root);
  async function entry(input: unknown) {
    if (typeof input !== 'string' || !/\.mjs$/i.test(input)) throw new Error('Runtime plugin entries must be relative .mjs bundles.');
    const file = await realpath(withinPackage(root, input));
    const rel = relative(base, file);
    if (!rel || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) throw new Error('Runtime plugin entry escapes its package.');
    const info = await stat(file);
    if (!info.isFile() || info.size > 16_000_000) throw new Error('Runtime plugin entry is missing or exceeds 16 MB.');
    return file;
  }
  return { id, apiVersion: 1, entry: await entry(value.entry), ...(value.renderer === undefined ? {} : { renderer: await entry(value.renderer) }) };
}

export async function readRuntimePluginBundle(path: string) {
  const bytes = await readFile(path);
  if (bytes.byteLength > 16_000_000) throw new Error('Runtime plugin bundle exceeds 16 MB.');
  return { source: bytes.toString('utf8'), hash: createHash('sha256').update(bytes).digest('hex') };
}
