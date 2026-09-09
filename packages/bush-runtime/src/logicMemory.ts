import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { retrieveLogic } from "./logicRetrieval.js";

export type LogicFeedbackRating = "up" | "down";

export interface LogicFeedbackInput {
  logicId: string;
  rating: LogicFeedbackRating | null;
  sourceId: string;
  source?: string;
  note?: string;
}

export interface LogicFeedbackBatchResult {
  updatedLogicIds: string[];
  missingLogicIds: string[];
  rating: LogicFeedbackRating | null;
}

type LogicRecord = Record<string, unknown>;
type LogicFeedbackEvent = {
  source_id: string;
  rating: LogicFeedbackRating;
  reward: number;
  source: string;
  note: string;
  updated_at: string;
  scope: "logic" | "turn";
};

const MAX_FEEDBACK_EVENTS = 40;
const RL_POLICY_VERSION = "lem-attributed-feedback-v2";

export class LogicMemoryStore {
  readonly path: string;
  #mutation: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.path = resolve(path);
  }

  async consult(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.#mutation;
    const mode = input.mode ?? "search";
    if (mode !== "search" && mode !== "list") throw new Error("mode must be search or list.");
    const records = await this.#read();
    if (mode === "list") {
      const offset = clampInteger(input.offset, 0, Number.MAX_SAFE_INTEGER, 0);
      const limit = clampInteger(input.max_results, 1, 10, 10);
      const page = records.slice(offset, offset + limit);
      return {
        status: records.length ? "ok" : "empty",
        tool: "consult_logic",
        mode: "inventory",
        usage_contract: "Inventory of stored reasoning lessons, not relevance matches or adopted advice.",
        total_count: records.length,
        records: page.map((record) => ({
          logic_id: logicId(record),
          scenario: boundedText(record.scenario, 400),
          conditions: textList(record.conditions, 16),
          evidence_state: record.evidence_state === "verified" ? "verified" : "unverified",
        })),
        next_offset: offset + page.length < records.length ? offset + page.length : null,
      };
    }
    const query = boundedText(input.query, 1_000);
    if (!query) throw new Error("query is required.");
    const scenarioConditions = textList(input.scenario_conditions, 16);
    const decisionContext = boundedText(input.decision_context, 1_600);
    const cognitivePatterns = textList(input.cognitive_patterns, 16).map(normalizeLabel);
    const matches = retrieveLogic(records.map(applyFeedbackMetrics), [
      query,
      scenarioConditions.join(" "),
      decisionContext,
      cognitivePatterns.join(" "),
    ]).slice(0, clampInteger(input.max_results, 1, 10, 3));
    return {
      status: matches.length ? "ok" : "no_learned_match",
      tool: "consult_logic",
      mode: "advisory_memory",
      usage_contract:
        "BM25 lexical candidates, not semantic relevance guarantees, task answers or policy. Scores order this query's candidates; confidence and evidence_state are stored lesson claims, not relevance probabilities or independent verification.",
      retrieval_method: "bm25",
      matched_count: matches.length,
      matched_logic: matches.map(({ record, score, matchedTerms }) => ({
        logic_id: logicId(record),
        scenario: boundedText(record.scenario, 400),
        conditions: textList(record.conditions, 16),
        cognitive_patterns: textList(record.cognitive_patterns, 16),
        bias: boundedText(record.bias, 600),
        correction: boundedText(record.correction ?? record.correction_logic ?? record.lesson, 800),
        reflection_question: boundedText(
          record.reflection_question ?? record.reflection_prompt,
          800,
        ),
        confidence: finiteNumber(record.confidence, 0.7),
        evidence_state: record.evidence_state === "verified" ? "verified" : "unverified",
        evidence: boundedText(record.evidence, 800),
        outcome: boundedText(record.outcome, 500),
        reward_score: finiteNumber(record.reward_score, 0),
        suppression_score: finiteNumber(record.suppression_score, 0),
        score: Number(score.toFixed(4)),
        matched_terms: matchedTerms.slice(0, 24),
      })),
      ...(matches.length
        ? {}
        : { message: "No learned local reasoning record matched; no fallback was synthesized." }),
    };
  }

  async learn(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    input = decodeLogicLearnInput(input);
    const action = input.action;
    if (action === "feedback") {
      const logicIdValue = boundedText(input.logic_id, 160);
      if (!logicIdValue) throw new Error("logic_id is required for feedback.");
      const rating = feedbackRating(input);
      const result = await this.recordFeedback({
        logicId: logicIdValue,
        rating,
        sourceId: boundedText(input.source_id, 240) || `tool:${randomUUID()}`,
        source: boundedText(input.source, 120) || "learn_logic",
        note: boundedText(input.note ?? input.feedback, 300),
      });
      return {
        status: result.updatedLogicIds.length ? "feedback_recorded" : "not_found",
        tool: "learn_logic",
        action: "feedback",
        logic_id: logicIdValue,
        rating,
        reward: rating === "up" ? 1 : -1,
        rl_policy_version: RL_POLICY_VERSION,
      };
    }
    if (action !== "learn") throw new Error("action must be learn or feedback.");

    const scenario = boundedText(input.scenario, 400);
    if (!scenario) throw new Error("scenario is required.");
    const bias = boundedText(input.bias, 600);
    const correction = boundedText(input.correction, 800);
    if (!bias && !correction) throw new Error("bias or correction is required.");
    const conditions = canonicalConditions(input.conditions);
    const cognitivePatterns = textList(input.cognitive_patterns, 16).map(normalizeLabel);
    let id = learningIdentity({ scenario, bias, correction, conditions });
    const now = new Date().toISOString();
    let stored: LogicRecord = {};
    await this.#mutate(async (records) => {
      // Recognize pre-canonicalization identities without changing their stable IDs.
      const index = records.findIndex((record) => logicId(record) === id || learningIdentity(record) === id);
      const existing = index >= 0 ? records[index]! : undefined;
      if (existing && logicId(existing)) id = logicId(existing);
      const evidence = boundedText(input.evidence ?? existing?.evidence, 800);
      const newEvidence = Boolean(evidence && evidence !== boundedText(existing?.evidence, 800));
      const learningCount = existing
        ? Math.min(9_999, clampInteger(existing.learning_count, 1, 9_999, 1) + (newEvidence ? 1 : 0))
        : 1;
      const requestedConfidence = clampNumber(input.confidence ?? existing?.base_confidence, 0.1, 0.98, 0.76);
      const evidenceState = boundedText(input.evidence_state ?? existing?.evidence_state, 20) === "verified"
        ? "verified"
        : "unverified";
      const baseConfidence = Math.min(
        evidenceState === "verified" ? 0.98 : 0.8,
        existing && !newEvidence ? finiteNumber(existing.base_confidence ?? existing.confidence, requestedConfidence) : requestedConfidence,
      );
      stored = applyFeedbackMetrics({
        ...(existing ?? {}),
        logic_id: id,
        created_at: boundedText(existing?.created_at, 80) || now,
        updated_at: now,
        schema_version: 3,
        scenario,
        conditions,
        cognitive_patterns: input.cognitive_patterns === undefined ? existing?.cognitive_patterns ?? [] : cognitivePatterns,
        bias,
        correction,
        reflection_question: boundedText(input.reflection_question ?? existing?.reflection_question, 800),
        chain: textList(input.chain ?? existing?.chain, 20),
        tags: textList(input.tags ?? existing?.tags, 12),
        evidence,
        outcome: boundedText(input.outcome ?? existing?.outcome, 500),
        evidence_state: evidenceState,
        base_confidence: baseConfidence,
        learning_count: learningCount,
        feedback_events: feedbackEvents(existing),
        rl_policy_version: RL_POLICY_VERSION,
      });
      if (index >= 0) records[index] = stored;
      else records.push(stored);
    });
    return {
      status: "learned",
      tool: "learn_logic",
      logic_id: id,
      storage: "runtime_json",
      path: this.path,
      evidence_state: stored.evidence_state,
      confidence: stored.confidence,
      reinforcement_count: stored.reinforcement_count,
      reward_score: stored.reward_score,
      suppression_score: stored.suppression_score,
      rl_policy_version: RL_POLICY_VERSION,
      usage_contract:
        "Stored as advisory reasoning memory; future retrieval does not turn it into task policy or facts.",
    };
  }

  async recordFeedback(input: LogicFeedbackInput): Promise<LogicFeedbackBatchResult> {
    return this.recordFeedbackForLogicIds([input.logicId], input.rating, {
      sourceId: input.sourceId,
      source: input.source,
      note: input.note,
    });
  }

  async recordFeedbackForLogicIds(
    logicIds: string[],
    rating: LogicFeedbackRating | null,
    options: { sourceId: string; source?: string; note?: string; scope?: "logic" | "turn" },
  ): Promise<LogicFeedbackBatchResult> {
    const requested = [...new Set(logicIds.map((value) => value.trim()).filter(Boolean))];
    const updatedLogicIds: string[] = [];
    const missingLogicIds: string[] = [];
    const sourceId = options.sourceId.trim();
    if (!sourceId) throw new Error("feedback sourceId is required.");
    if (!requested.length) return { updatedLogicIds, missingLogicIds, rating };
    await this.#mutate(async (records) => {
      for (const requestedId of requested) {
        const index = records.findIndex((record) => logicId(record) === requestedId);
        if (index < 0) {
          missingLogicIds.push(requestedId);
          continue;
        }
        const current = records[index]!;
        const events = feedbackEvents(current).filter((event) => event.source_id !== sourceId);
        if (rating) {
          events.push({
            source_id: sourceId,
            rating,
            reward: rating === "up" ? 1 : -1,
            source: boundedText(options.source, 120) || (options.scope === "turn" ? "user_thumb" : "logic_feedback"),
            note: boundedText(options.note, 300),
            updated_at: new Date().toISOString(),
            scope: options.scope ?? "logic",
          });
        }
        records[index] = applyFeedbackMetrics({
          ...current,
          updated_at: new Date().toISOString(),
          // Turn feedback cannot evict explicit lesson feedback and indirectly alter its score.
          feedback_events: [
            ...events.filter((event) => event.scope === "logic").slice(-MAX_FEEDBACK_EVENTS),
            ...events.filter((event) => event.scope === "turn").slice(-MAX_FEEDBACK_EVENTS),
          ],
          rl_policy_version: RL_POLICY_VERSION,
        });
        updatedLogicIds.push(requestedId);
      }
    });
    return { updatedLogicIds, missingLogicIds, rating };
  }

  async #read(): Promise<LogicRecord[]> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8"));
      if (!Array.isArray(parsed) || parsed.some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
        throw new Error("Invalid LEM store: expected an array of records.");
      }
      return parsed as LogicRecord[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async #mutate(operation: (records: LogicRecord[]) => void | Promise<void>): Promise<void> {
    const run = this.#mutation.then(async () => {
      const records = await this.#read();
      await operation(records);
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(records, null, 2)}\n`, "utf8");
      try {
        await rename(temporary, this.path);
      } finally {
        // Never delete the last committed store to work around a failed replacement.
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    });
    this.#mutation = run.catch(() => undefined);
    return run;
  }
}

function applyFeedbackMetrics(record: LogicRecord): LogicRecord {
  const events = feedbackEvents(record);
  const positive = events.filter((event) => event.scope === "logic" && event.rating === "up").length;
  const negative = events.filter((event) => event.scope === "logic" && event.rating === "down").length;
  const baseConfidence = clampNumber(
    record.base_confidence ?? record.confidence,
    0.1,
    0.98,
    0.7,
  );
  const learningCount = clampInteger(record.learning_count, 1, 9_999, 1);
  return {
    ...record,
    feedback_events: events,
    positive_feedback_count: positive,
    negative_feedback_count: negative,
    turn_positive_feedback_count: events.filter((event) => event.scope === "turn" && event.rating === "up").length,
    turn_negative_feedback_count: events.filter((event) => event.scope === "turn" && event.rating === "down").length,
    reward_score: positive - negative,
    suppression_score: Math.max(0, negative - positive * 0.45),
    confidence: clampNumber(baseConfidence + positive * 0.08 - negative * 0.12, 0.1, 0.98, baseConfidence),
    reinforcement_count: learningCount + positive,
  };
}

function feedbackEvents(record?: LogicRecord): LogicFeedbackEvent[] {
  const raw = record?.feedback_events;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const value = candidate as Record<string, unknown>;
    const rating = value.rating === "up" || value.rating === "down"
      ? value.rating
      : finiteNumber(value.reward, 0) >= 0
        ? "up"
        : "down";
    const sourceId = boundedText(value.source_id, 240);
    if (!sourceId) return [];
    return [{
      source_id: sourceId,
      rating,
      reward: rating === "up" ? 1 : -1,
      source: boundedText(value.source, 120),
      note: boundedText(value.note, 300),
      updated_at: boundedText(value.updated_at, 80),
      scope: value.scope === "logic" ? "logic" : value.scope === "turn" || value.source === "user_thumb" ? "turn" : "logic",
    } satisfies LogicFeedbackEvent];
  });
}

function feedbackRating(input: Record<string, unknown>): LogicFeedbackRating {
  const feedback = boundedText(input.feedback, 40).toLowerCase();
  if (["thumbs_up", "helpful", "success", "positive", "up"].includes(feedback)) return "up";
  if (["thumbs_down", "unhelpful", "failure", "negative", "down"].includes(feedback)) return "down";
  const reward = input.reward == null || input.reward === ""
    ? finiteNumber(input.rating, 0) / 5
    : finiteNumber(input.reward, 0);
  if (reward === 0) throw new Error("feedback, reward, or a non-zero rating is required.");
  return reward > 0 ? "up" : "down";
}

function logicId(record: LogicRecord): string {
  return boundedText(record.logic_id ?? record.id, 160);
}

function canonicalConditions(value: unknown): string[] {
  return [...new Set(textList(value, 16).map((condition) => condition.normalize("NFKC")))].sort();
}

function learningIdentity(record: LogicRecord): string {
  return `logic_${createHash("sha256").update(JSON.stringify([
    boundedText(record.scenario, 400), boundedText(record.bias, 600),
    boundedText(record.correction ?? record.correction_logic ?? record.lesson, 800), canonicalConditions(record.conditions),
  ])).digest("hex").slice(0, 24)}`;
}

export function decodeLogicLearnInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object.");
  const input = value as Record<string, unknown>;
  const textFields = ["logic_id", "scenario", "bias", "correction", "reflection_question", "evidence", "outcome", "source", "source_id", "note", "feedback", "evidence_state"];
  const listFields = ["cognitive_patterns", "conditions", "chain", "tags"];
  const fields = new Set(["action", "confidence", "reward", "rating", ...textFields, ...listFields]);
  for (const key of Object.keys(input)) {
    if (!fields.has(key)) throw new Error(`Unknown learning field: ${key}.`);
  }
  for (const key of textFields) {
    if (input[key] !== undefined && typeof input[key] !== "string") throw new Error(`${key} must be a string.`);
  }
  for (const key of listFields) {
    const list = input[key];
    if (list !== undefined && typeof list !== "string" && (!Array.isArray(list) || list.some((item) => typeof item !== "string"))) {
      throw new Error(`${key} must be a string or string array.`);
    }
  }
  if (input.confidence !== undefined && (typeof input.confidence !== "number" || !Number.isFinite(input.confidence) || input.confidence < 0.1 || input.confidence > 0.98)) {
    throw new Error("confidence must be a number between 0.1 and 0.98.");
  }
  if (input.evidence_state !== undefined && input.evidence_state !== "verified" && input.evidence_state !== "unverified") {
    throw new Error("evidence_state must be verified or unverified.");
  }
  const action = input.action ?? (input.logic_id !== undefined ? "feedback" : "learn");
  if (action !== "learn" && action !== "feedback") throw new Error("action must be learn or feedback.");
  const hasText = (key: string) => typeof input[key] === "string" && Boolean((input[key] as string).trim());
  for (const key of ["logic_id", "scenario", "bias", "correction"]) {
    if (input[key] !== undefined && !hasText(key)) throw new Error(`${key} must not be empty.`);
  }
  if (action === "feedback") {
    if (!hasText("logic_id") || input.scenario !== undefined) throw new Error("Feedback requires logic_id without a learning scenario.");
    for (const [key, maximum] of [["reward", 1], ["rating", 5]] as const) {
      if (input[key] !== undefined && (typeof input[key] !== "number" || !Number.isFinite(input[key]) || input[key] === 0 || Math.abs(input[key]) > maximum)) {
        throw new Error(`${key} must be a non-zero number between -${maximum} and ${maximum}.`);
      }
    }
    if (input.feedback !== undefined && !["thumbs_up", "thumbs_down", "helpful", "unhelpful", "success", "failure", "positive", "negative", "up", "down"].includes(String(input.feedback))) {
      throw new Error("Unknown feedback rating.");
    }
    feedbackRating(input);
  } else {
    if (!hasText("scenario")) throw new Error("scenario is required.");
    if (!hasText("bias") && !hasText("correction")) throw new Error("bias or correction is required.");
    if (["logic_id", "feedback", "reward", "rating"].some((key) => input[key] !== undefined)) {
      throw new Error("Do not mix learning and feedback fields.");
    }
  }
  return { ...input, action };
}

function textList(value: unknown, limit: number): string[] {
  const candidates = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,;\n]/)
      : [];
  return [...new Set(candidates.map((item) => boundedText(item, 300)).filter(Boolean))].slice(0, limit);
}

function normalizeLabel(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}_]+/gu, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
}

function boundedText(value: unknown, limit: number): string {
  const normalized = String(value ?? "").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function finiteNumber(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clampNumber(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return Math.min(maximum, Math.max(minimum, finiteNumber(value, fallback)));
}

function clampInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return Math.trunc(clampNumber(value, minimum, maximum, fallback));
}
