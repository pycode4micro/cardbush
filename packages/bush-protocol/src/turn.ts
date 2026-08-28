import { z } from "zod";

export const BUSH_TASK_PLAN_PROTOCOL = "bush.task_plan.v1" as const;
export const BUSH_OUTCOME_FINALIZER_PROTOCOL = "bush.outcome_finalizer.v1" as const;

export const taskNodeSchema = z.object({
  id: z.string().optional(),
  step: z.string().min(1),
  status: z.enum(["pending", "in_progress", "completed"]),
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

export const outcomeFinalizerSchema = z.object({
  protocol: z.literal(BUSH_OUTCOME_FINALIZER_PROTOCOL),
  status: z.enum(["complete", "continue", "blocked", "awaiting_input"]),
  result_intent: z.enum(["conversation", "deliverable", "uncertain"]),
  required_evidence: z.array(z.string()),
  observed_evidence: z.array(z.string()),
  missing_evidence: z.array(z.string()),
  blocking_facts: z.array(z.string()),
  reason: z.string(),
  required_acceptance: z.array(z.string()),
  passed_acceptance: z.array(z.string()),
  failed_acceptance: z.array(z.string()),
  stale_acceptance: z.array(z.string()),
});

export type OutcomeFinalizerDecision = z.infer<typeof outcomeFinalizerSchema>;
