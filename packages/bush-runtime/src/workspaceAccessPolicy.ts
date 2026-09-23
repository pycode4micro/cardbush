import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { ToolAdmissionContext } from './toolRegistry.js';

interface PathInput { path: string }

/** Tool admission only. OS command isolation is enforced by the execution backend. */
export function authorizePath(action: "read" | "write") {
  return async (context: ToolAdmissionContext<PathInput>) => {
    const path = await resolveToolPath(context, context.input.path, action === "write");
    return pathAdmission(context, path, action);
  };
}

export async function pathAdmission(
  context: ToolAdmissionContext<unknown>,
  path: string,
  action: string,
): Promise<
  | { kind: "allow" }
  | {
      kind: "ask";
      request: {
        reason: string;
        actions: string[];
        targets: Array<{ kind: "filesystem_path"; value: string }>;
        capabilityIds: string[];
        scope: {
          mode: "task_free" | "user_free";
          roots: string[];
        };
      };
    }
> {
  const mode = permissionBoundaryMode(context);
  const roots = await Promise.all(allowedRoots(context, mode).map(canonicalPath));
  if (roots.some((root) => isWithin(root, path))) return { kind: "allow" } as const;
  const capabilityId = capability(action, path);
  return {
    kind: "ask" as const,
    request: {
      reason: `${action} requires access outside the ${mode === "user_free" ? "user" : "task"} roots.`,
      actions: [action],
      targets: [{ kind: "filesystem_path", value: path }],
      capabilityIds: [capabilityId],
      scope: { mode, roots },
    },
  };
}

export function permissionBoundaryMode(context: ToolAdmissionContext<unknown>): "task_free" | "user_free" {
  const candidate = context.turn?.request.permissionMode;
  return candidate === "user_free" ? candidate : "task_free";
}

export function allowedRoots(
  context: ToolAdmissionContext<unknown>,
  mode: "task_free" | "user_free",
): string[] {
  const metadata = context.turn?.request.metadata ?? {};
  const taskRoots = rootStringArray(metadata.taskRoots);
  const configuredUserRoots = rootStringArray(metadata.userRoots);
  const userRoots = mode === "user_free"
    ? (configuredUserRoots.length > 0 ? configuredUserRoots : [homedir()])
    : [];
  const workspace = workspaceRoot(context);
  return [...new Set([
    ...(workspace ? [workspace] : []),
    ...taskRoots,
    ...userRoots,
  ].map((item) => resolve(item)))];
}

function rootStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

export async function resolveToolPath(
  context: ToolAdmissionContext<unknown>,
  candidate: string,
  allowMissing = false,
): Promise<string> {
  const root = workspaceRoot(context);
  const normalized = candidate.trim();
  if (!normalized) {
    throw codedError(
      "workspace_path_required",
      "An absolute path is required when the Turn has no workspaceDir.",
    );
  }
  if (!isAbsolute(normalized) && !root) {
    throw codedError(
      "workspace_relative_path_without_root",
      "Relative paths require a workspaceDir; use an absolute path instead.",
    );
  }
  const lexical = resolve(isAbsolute(normalized) ? normalized : resolve(root!, normalized));
  try {
    return await realpath(lexical);
  } catch (error) {
    if (!allowMissing) throw error;
    let ancestor = dirname(lexical);
    while (true) {
      try {
        const canonicalAncestor = await realpath(ancestor);
        return resolve(canonicalAncestor, relative(ancestor, lexical));
      } catch {
        const parent = dirname(ancestor);
        if (parent === ancestor) throw error;
        ancestor = parent;
      }
    }
  }
}

export function workspaceRoot(context: ToolAdmissionContext<unknown>): string | undefined {
  const metadata = context.turn?.request.metadata ?? {};
  const candidate = [metadata.workspaceDir, metadata.projectDir, metadata.sessionWorkspaceDir]
    .find((value) => typeof value === "string" && value.trim());
  return typeof candidate === "string" ? resolve(candidate) : undefined;
}

export function protectedProjectRoots(context: ToolAdmissionContext<unknown>): string[] {
  const metadata = context.turn?.request.metadata ?? {};
  return [...new Set([
    metadata.projectDir,
    metadata.workspaceDir,
    metadata.sessionWorkspaceDir,
    ...rootStringArray(metadata.taskRoots),
  ].filter((value): value is string =>
    typeof value === "string" && value.trim().length > 0
  ).map((value) => resolve(value)))];
}

export function normalizeIdentity(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function isWithin(root: string, path: string): boolean {
  const value = relative(resolve(root), resolve(path));
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

function capability(action: string, path: string): string {
  return `capability:${action}:${createHash("sha256").update(normalizeIdentity(path)).digest("hex")}`;
}

async function canonicalPath(path: string): Promise<string> {
  return realpath(resolve(path));
}

function codedError(code: string, message: string) { return Object.assign(new Error(message), { code }); }
