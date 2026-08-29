import { randomUUID } from "node:crypto";

import {
  runtimeInteractionAnswerSchema,
  runtimeInteractionSchema,
  type RuntimeInteraction,
  type RuntimeInteractionAnswer,
} from "@cardbush/bush-protocol";

export interface RuntimeInteractionStoreOptions {
  createId?: () => string;
  now?: () => Date;
  onRequested?: (interaction: RuntimeInteraction) => void;
  onAnswered?: (interaction: RuntimeInteraction, answer: RuntimeInteractionAnswer) => void;
  onCancelled?: (interaction: RuntimeInteraction, reason: string) => void;
  onExpired?: (interaction: RuntimeInteraction) => void;
}

interface PendingEntry {
  interaction: RuntimeInteraction;
  resolve: (answer: RuntimeInteractionAnswer) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  removeAbortListener: () => void;
}

export class RuntimeInteractionStore {
  readonly #pending = new Map<string, PendingEntry>();
  readonly #createId: () => string;
  readonly #now: () => Date;
  readonly #options: RuntimeInteractionStoreOptions;

  constructor(options: RuntimeInteractionStoreOptions = {}) {
    this.#options = options;
    this.#createId = options.createId ?? (() => `interaction_${randomUUID()}`);
    this.#now = options.now ?? (() => new Date());
  }

  request(
    input: Omit<RuntimeInteraction, "protocol" | "interactionId" | "createdAt" | "expiresAt"> & {
      timeoutMinutes?: number;
    },
    signal?: AbortSignal,
  ): Promise<RuntimeInteractionAnswer> {
    if (signal?.aborted) return Promise.reject(abortError());
    const created = this.#now();
    const timeoutMinutes = Math.max(1, Math.min(1440, input.timeoutMinutes ?? 10));
    const interaction = runtimeInteractionSchema.parse({
      protocol: "bush.runtime_interaction.v1",
      interactionId: this.#createId(),
      sessionId: input.sessionId,
      turnId: input.turnId,
      toolCallId: input.toolCallId,
      title: input.title,
      description: input.description,
      reason: input.reason,
      questions: input.questions,
      submitLabel: input.submitLabel,
      cancelLabel: input.cancelLabel,
      createdAt: created.toISOString(),
      expiresAt: new Date(created.getTime() + timeoutMinutes * 60_000).toISOString(),
    });
    return new Promise((resolve, reject) => {
      const finishCancellation = (reason: string) => {
        const pending = this.#pending.get(interaction.interactionId);
        if (!pending) return;
        this.#pending.delete(interaction.interactionId);
        clearTimeout(pending.timer);
        pending.removeAbortListener();
        this.#options.onCancelled?.(interaction, reason);
        pending.reject(abortError());
      };
      const onAbort = () => finishCancellation("turn_cancelled");
      const timer = setTimeout(() => {
        const pending = this.#pending.get(interaction.interactionId);
        if (!pending) return;
        this.#pending.delete(interaction.interactionId);
        pending.removeAbortListener();
        this.#options.onExpired?.(interaction);
        pending.reject(new Error("Interactive request expired."));
      }, timeoutMinutes * 60_000);
      const removeAbortListener = () => signal?.removeEventListener("abort", onAbort);
      this.#pending.set(interaction.interactionId, {
        interaction,
        resolve,
        reject,
        timer,
        removeAbortListener,
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#options.onRequested?.(interaction);
    });
  }

  answer(candidate: unknown): RuntimeInteractionAnswer {
    const answer = runtimeInteractionAnswerSchema.parse(candidate);
    const pending = this.#pending.get(answer.interactionId);
    if (!pending) throw new Error(`Interaction ${answer.interactionId} is not pending.`);
    validateAnswer(pending.interaction, answer);
    this.#pending.delete(answer.interactionId);
    clearTimeout(pending.timer);
    pending.removeAbortListener();
    if (answer.decision === "cancel") {
      this.#options.onCancelled?.(pending.interaction, "user_cancelled");
    } else {
      this.#options.onAnswered?.(pending.interaction, answer);
    }
    pending.resolve(answer);
    return answer;
  }

  list(input: { sessionId?: string; turnId?: string } = {}): RuntimeInteraction[] {
    return [...this.#pending.values()]
      .map((entry) => entry.interaction)
      .filter((item) => !input.sessionId || item.sessionId === input.sessionId)
      .filter((item) => !input.turnId || item.turnId === input.turnId)
      .map((item) => structuredClone(item));
  }
}

function validateAnswer(interaction: RuntimeInteraction, answer: RuntimeInteractionAnswer): void {
  if (answer.decision === "cancel") return;
  const byId = new Map(answer.answers.map((item) => [item.questionId, item]));
  for (const question of interaction.questions) {
    const value = byId.get(question.id);
    if (question.required && !value) throw new Error(`Question ${question.id} requires an answer.`);
    if (!value) continue;
    const valid = new Set(question.options.map((option) => option.id));
    const selected = [
      ...(value.selectedOptionId ? [value.selectedOptionId] : []),
      ...(value.selectedOptionIds ?? []),
    ];
    if (selected.some((id) => !valid.has(id))) {
      throw new Error(`Question ${question.id} contains an unknown option.`);
    }
    if (question.selectionMode === "input" && !value.inputText?.trim()) {
      throw new Error(`Question ${question.id} requires text input.`);
    }
  }
}

function abortError(): Error {
  const error = new Error("Interactive request was cancelled.");
  error.name = "AbortError";
  return error;
}
