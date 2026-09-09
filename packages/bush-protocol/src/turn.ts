import { z } from "zod";

export const BUSH_TASK_PLAN_PROTOCOL = "bush.task_plan.v1" as const;

export const taskNodeSchema = z.object({
  id: z.string().optional(),
  step: z.string().min(1),
  status: z.enum(["pending", "in_progress", "waiting", "completed"]),
  waitingFor: z.string().trim().min(1).optional(),
}).superRefine((node, context) => {
  if (node.status === "waiting" && !node.waitingFor) {
    context.addIssue({ code: "custom", path: ["waitingFor"], message: "waiting nodes must state the external dependency or user action needed to continue" });
  }
  if (node.status !== "waiting" && node.waitingFor !== undefined) {
    context.addIssue({ code: "custom", path: ["waitingFor"], message: "waitingFor applies only to waiting nodes" });
  }
});

export const taskPlanSchema = z
  .object({
    protocol: z.literal(BUSH_TASK_PLAN_PROTOCOL),
    plan_id: z.string().min(1),
    session_id: z.string().min(1),
    nodes: z.array(taskNodeSchema).min(1).max(20),
    explanation: z.string(),
    active: z.boolean(),
  })
  .superRefine((plan, context) => {
    if (plan.nodes.filter((node) => node.status === "in_progress").length > 1) {
      context.addIssue({
        code: "custom",
        message: "at most one step may be in_progress",
        path: ["nodes"],
      });
    }
    const ids = plan.nodes.flatMap((node) => (node.id ? [node.id] : []));
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        message: "task-plan node ids must be unique",
        path: ["nodes"],
      });
    }
    const expectedActive = plan.nodes.some((node) => node.status !== "completed");
    if (plan.active !== expectedActive) {
      context.addIssue({
        code: "custom",
        message: "active must reflect whether the plan has open nodes",
        path: ["active"],
      });
    }
  });

export type TaskPlan = z.infer<typeof taskPlanSchema>;
