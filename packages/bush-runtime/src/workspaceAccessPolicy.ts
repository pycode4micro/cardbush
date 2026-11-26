import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { PERSONAL_ASSISTANT_SESSION } from '@cardbush/bush-protocol';
import type { ToolAdmissionContext, ToolPermissionRequest } from './toolRegistry.js';

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
      request: ToolPermissionRequest;
    }
> {
  const mode = permissionBoundaryMode(context);
  const roots = await Promise.all(allowedRoots(context, mode).map(canonicalPath));
  if (roots.some((root) => isWithin(root, path))) return { kind: "allow" } as const;
  const capabilityId = capability(action, path);
  const assistantApproval = usesAssistantWorkspaceApproval(context);
  return {
    kind: "ask" as const,
    request: {
      reason: `${action} requires access outside the ${mode === "user_free" ? "user" : "task"} roots.`,
      actions: [action],
      targets: [{ kind: "filesystem_path", value: path }],
      capabilityIds: [capabilityId],
      scope: { mode, roots },
      ...(assistantApproval ? { outsideParentScope: !(await parentCoversPath(context, path, action)) }
        : action === 'write' && isParentApprovedChild(context) ? { requiresHuman: true } : {}),
    },
  };
}

export function isParentApprovedChild(context: ToolAdmissionContext<unknown>) {
  const metadata = context.turn?.request.metadata;
  return metadata?.agentRole === 'child' && metadata.permissionRouting === 'parent';
}

export function usesAssistantWorkspaceApproval(context: ToolAdmissionContext<unknown>) {
  const metadata = context.turn?.request.metadata;
  return isParentApprovedChild(context) && metadata?.parentSessionId === PERSONAL_ASSISTANT_SESSION && !metadata.remoteDelegation;
}

async function parentCoversPath(context: ToolAdmissionContext<unknown>, path: string, action: string) {
  if (action === 'read' && context.isTurnAttachment?.(path)) return true;
  const parent = context.parentWorkspaceAuthority;
  if (!parent) return false;
  if (parent.permissionMode === 'all_free') return true;
  const roots = workspaceRoots(parent.metadata, parent.permissionMode === 'user_free' ? 'user_free' : 'ask_for_approval');
  const canonical = await Promise.all(roots.map(root => canonicalPath(root).catch(() => undefined)));
  return canonical.some(root => root !== undefined && isWithin(root, path));
}

export function permissionBoundaryMode(context: ToolAdmissionContext<unknown>): "ask_for_approval" | "user_free" {
  const candidate = context.turn?.request.permissionMode;
  return candidate === "user_free" ? candidate : "ask_for_approval";
}

export function allowedRoots(
  context: ToolAdmissionContext<unknown>,
  mode: "ask_for_approval" | "user_free",
): string[] {
  return workspaceRoots(context.turn?.request.metadata ?? {}, mode);
}

function workspaceRoots(metadata: Record<string, unknown>, mode: 'ask_for_approval' | 'user_free'): string[] {
  const taskRoots = rootStringArray(metadata.taskRoots);
  const configuredUserRoots = rootStringArray(metadata.userRoots);
  const userRoots = mode === "user_free"
    ? (configuredUserRoots.length > 0 ? configuredUserRoots : [homedir()])
    : [];
  const workspace = workspaceRootFromMetadata(metadata);
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
  return workspaceRootFromMetadata(context.turn?.request.metadata ?? {});
}

export function workspaceRootFromMetadata(metadata: Record<string, unknown>): string | undefined {
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
  return value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

function capability(action: string, path: string): string {
  return `capability:${action}:${createHash("sha256").update(normalizeIdentity(path)).digest("hex")}`;
}

async function canonicalPath(path: string): Promise<string> {
  return realpath(resolve(path));
}

function codedError(code: string, message: string) { return Object.assign(new Error(message), { code }); }
