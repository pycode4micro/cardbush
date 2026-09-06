import { z } from "zod";
import { workspaceChangeSchema } from "./tool.js";

export const GET_RUNTIME_WORKSPACE_COMMAND = "runtime.get_workspace" as const;
export const UPDATE_RUNTIME_WORKSPACE_COMMAND = "runtime.update_workspace" as const;
export const RUNTIME_WORKSPACE_METADATA_KEY = "runtimeWorkspace" as const;

export const workspaceSetupSchema = z.object({
  mode: z.enum(["auto", "direct", "worktree"]),
  sourceDir: z.string().min(1),
});

export const workspaceDescriptorSchema = z.object({
  mode: z.enum(["direct", "worktree"]),
  sessionId: z.string().min(1),
  sourceDir: z.string().min(1),
  workspaceDir: z.string().min(1),
  revision: z.number().int().positive(),
  status: z.enum(["ready", "discarded"]),
  baselineId: z.string().optional(),
  sourceHead: z.string().optional(),
  versioning: z.enum(["git", "none"]).optional(),
  versioningError: z.string().optional(),
});
export type WorkspaceDescriptor = z.infer<typeof workspaceDescriptorSchema>;

export const workspaceCheckpointSchema = z.object({
  turnId: z.string().min(1),
  createdAt: z.string(),
  capturedAt: z.string().optional(),
  backgroundProcesses: z.boolean().optional(),
  status: z.enum(["pending", "complete", "failed", "reverted"]),
  error: z.string().optional(),
  changes: z.array(workspaceChangeSchema),
});
export type WorkspaceCheckpoint = z.infer<typeof workspaceCheckpointSchema>;

export const workspaceReviewSchema = z.object({
  workspace: workspaceDescriptorSchema,
  checkpoints: z.array(workspaceCheckpointSchema),
  changes: z.array(workspaceChangeSchema),
  error: z.string().optional(),
  snapshotId: z.string().optional(),
  runningTerminals: z.boolean().optional(),
});
export type WorkspaceReview = z.infer<typeof workspaceReviewSchema>;

export const workspaceReadSchema = z.object({
  sessionId: z.string().min(1),
  view: z.enum(["live", "history"]).default("live"),
});

export const workspaceUpdateSchema = z.object({
  sessionId: z.string().min(1),
  expectedRevision: z.number().int().positive(),
  action: z.enum(["apply", "discard", "use_direct", "checkpoint", "stop_terminals", "init_git"]),
  expectedSnapshotId: z.string().optional(),
});
