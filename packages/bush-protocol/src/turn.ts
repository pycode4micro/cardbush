import { z } from "zod";

export const BUSH_TASK_PLAN_PROTOCOL = "bush.task_plan.v1" as const;
export const BUSH_TURN_OUTCOME_DECLARATION_PROTOCOL =
  "bush.turn_outcome_declaration.v1" as const;

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

export const turnOutcomeDeclarationSchema = z.object({
  protocol: z.literal(BUSH_TURN_OUTCOME_DECLARATION_PROTOCOL),
  disposition: z.enum(["answer", "effect_complete", "blocked", "awaiting_input"]),
  receipt_ids: z.array(z.string().min(1)).default([]),
  final_response: z.string().min(1),
});

export type TurnOutcomeDeclaration = z.infer<typeof turnOutcomeDeclarationSchema>;
