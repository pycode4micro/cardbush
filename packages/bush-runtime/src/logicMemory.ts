import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

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
};

const MAX_FEEDBACK_EVENTS = 40;
const RL_POLICY_VERSION = "lem-lightweight-reward-v1";

export class LogicMemoryStore {
  readonly path: string;
  #mutation: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.path = resolve(path);
  }

  async consult(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.#mutation;
    const query = boundedText(input.query, 1_000);
    if (!query) throw new Error("query is required.");
    const scenarioConditions = textList(input.scenario_conditions, 16);
    const decisionContext = boundedText(input.decision_context, 1_600);
    const cognitivePatterns = textList(input.cognitive_patterns, 16).map(normalizeLabel);
    const requestedTerms = tokens(
      query,
      scenarioConditions.join(" "),
      decisionContext,
      cognitivePatterns.join(" "),
    );
    const maxResults = clampInteger(input.max_results, 1, 10, 5);
    const matches = (await this.#read())
      .map((record) => rankRecord(record, requestedTerms))
      .filter((candidate) => candidate.lexicalScore > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, maxResults);
    return {
      status: matches.length ? "ok" : "no_learned_match",
      tool: "consult_logic",
      mode: "advisory_memory",
      usage_contract:
        "These are retrieved local reasoning records, not task answers, execution steps, routing policy, or domain facts.",
      query,
      scenario_conditions: scenarioConditions,
      cognitive_patterns: cognitivePatterns,
      matched_count: matches.length,
      match_quality: matches.length === 0 ? "none" : matches[0]!.score >= 4 ? "strong" : "partial",
      reflection_questions: matches
        .map(({ record }) => boundedText(record.reflection_question ?? record.reflection_prompt, 800))
        .filter(Boolean),
      bias_warnings: matches
        .map(({ record }) => boundedText(record.bias, 600))
        .filter(Boolean),
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
        reward_score: finiteNumber(record.reward_score, 0),
        suppression_score: finiteNumber(record.suppression_score, 0),
        score: Number(score.toFixed(4)),
        matched_terms: matchedTerms,
      })),
      ...(matches.length
        ? {}
        : { message: "No learned local reasoning record matched; no fallback was synthesized." }),
    };
  }

  async learn(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const action = boundedText(input.action, 40).toLowerCase() || "learn";
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
    const correction = boundedText(input.correction ?? input.lesson, 800);
    if (!bias && !correction) throw new Error("bias or correction is required.");
    const conditions = textList(input.conditions, 16);
    const cognitivePatterns = textList(input.cognitive_patterns, 16).map(normalizeLabel);
    const id = `logic_${createHash("sha256")
      .update(JSON.stringify([scenario, bias, correction, conditions]))
      .digest("hex")
      .slice(0, 24)}`;
    const now = new Date().toISOString();
    let stored: LogicRecord = {};
    await this.#mutate(async (records) => {
      const index = records.findIndex((record) => logicId(record) === id);
      const existing = index >= 0 ? records[index]! : undefined;
      const learningCount = clampInteger(existing?.learning_count, 1, 9_999, 0) + 1;
      const requestedConfidence = clampNumber(input.confidence, 0.1, 0.98, 0.76);
      const evidenceState = boundedText(input.evidence_state, 20) === "verified"
        ? "verified"
        : "unverified";
      const baseConfidence = Math.min(
        evidenceState === "verified" ? 0.98 : 0.8,
        Math.max(requestedConfidence, finiteNumber(existing?.base_confidence, 0)) +
          (existing ? 0.04 : 0),
      );
      stored = applyFeedbackMetrics({
        ...(existing ?? {}),
        logic_id: id,
        created_at: boundedText(existing?.created_at, 80) || now,
        updated_at: now,
        schema_version: 2,
        scenario,
        conditions,
        cognitive_patterns: cognitivePatterns,
        bias,
        correction,
        reflection_question: boundedText(input.reflection_question, 800),
        chain: textList(input.chain, 20),
        tags: textList(input.tags, 12),
        evidence: boundedText(input.evidence, 800),
        outcome: boundedText(input.outcome, 500),
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
    options: { sourceId: string; source?: string; note?: string },
  ): Promise<LogicFeedbackBatchResult> {
    const requested = [...new Set(logicIds.map((value) => value.trim()).filter(Boolean))];
    const updatedLogicIds: string[] = [];
    const missingLogicIds: string[] = [];
    const sourceId = options.sourceId.trim();
    if (!sourceId) throw new Error("feedback sourceId is required.");
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
            source: boundedText(options.source, 120) || "user_thumb",
            note: boundedText(options.note, 300),
            updated_at: new Date().toISOString(),
          });
        }
        records[index] = applyFeedbackMetrics({
          ...current,
          updated_at: new Date().toISOString(),
          feedback_events: events.slice(-MAX_FEEDBACK_EVENTS),
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
      return Array.isArray(parsed)
        ? parsed.filter((item): item is LogicRecord => Boolean(item && typeof item === "object"))
        : [];
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
      await rename(temporary, this.path).catch(async () => {
        await rm(this.path, { force: true });
        await rename(temporary, this.path);
      });
    });
    this.#mutation = run.catch(() => undefined);
    return run;
  }
}

function applyFeedbackMetrics(record: LogicRecord): LogicRecord {
  const events = feedbackEvents(record);
  const positive = events.filter((event) => event.rating === "up").length;
  const negative = events.filter((event) => event.rating === "down").length;
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
    } satisfies LogicFeedbackEvent];
  });
}

function rankRecord(record: LogicRecord, requestedTerms: Set<string>) {
  const recordTerms = tokens(
    record.scenario,
    record.conditions,
    record.cognitive_patterns,
    record.bias,
    record.correction ?? record.correction_logic ?? record.lesson,
    record.reflection_question ?? record.reflection_prompt,
    record.tags,
  );
  const matchedTerms = [...requestedTerms].filter((term) => recordTerms.has(term));
  const lexicalScore = matchedTerms.length;
  const confidence = finiteNumber(record.confidence, 0.7);
  const reward = finiteNumber(record.reward_score, 0);
  const suppression = finiteNumber(record.suppression_score, 0);
  return {
    record,
    matchedTerms: matchedTerms.slice(0, 24),
    lexicalScore,
    score: lexicalScore + confidence + Math.min(4, Math.max(0, reward)) * 0.35 - suppression * 0.8,
  };
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

function tokens(...values: unknown[]): Set<string> {
  const normalized = values.flatMap((value) => {
    if (Array.isArray(value)) return value.map(String);
    return [String(value ?? "")];
  }).join(" ").normalize("NFKC").toLowerCase();
  const result = new Set(normalized.match(/[a-z0-9_]{2,}|[\p{Script=Han}]/gu) ?? []);
  const cjk = [...normalized].filter((character) => /\p{Script=Han}/u.test(character));
  for (let index = 0; index + 1 < cjk.length; index += 1) {
    result.add(`${cjk[index]}${cjk[index + 1]}`);
  }
  return result;
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
