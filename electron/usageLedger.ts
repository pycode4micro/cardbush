import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface UsageStatistics {
  startedAt: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  promptCacheHitTokens: number;
  promptCacheMissTokens: number;
  requestCount: number;
  conversationCount: number;
  activeDays: number;
  longestStreak: number;
  activity: Array<{ date: string; tokens: number; requests: number }>;
}

export interface UsageRecord {
  /** One actual provider stream invocation, independent of Turn/request reuse. */
  id: string;
  sessionId: string;
  model: string;
  recordedAt: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
}

/** Durable accounting facts, outside the disposable runtime state. */
export class UsageLedger {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, model TEXT NOT NULL,
        recorded_at TEXT NOT NULL, day TEXT NOT NULL,
        input_tokens INTEGER, output_tokens INTEGER, cached_input_tokens INTEGER
      );
      CREATE INDEX IF NOT EXISTS requests_day ON requests(day);
    `);
    this.#db.prepare("INSERT OR IGNORE INTO metadata VALUES ('started_at', ?)").run(new Date().toISOString());
  }

  record(record: UsageRecord) {
    const values = [record.inputTokens, record.outputTokens, record.cachedInputTokens];
    if (values.every(value => value === undefined)) return;
    if (values.some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0))) throw new Error('Invalid provider token usage.');
    const date = new Date(record.recordedAt);
    if (!Number.isFinite(date.getTime()) || !record.id || !record.sessionId) throw new Error('Invalid usage identity or timestamp.');
    const day = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
    // Corrected/cumulative events replace this stream's counters, never add twice.
    this.#db.prepare(`INSERT INTO requests VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        input_tokens = COALESCE(excluded.input_tokens, requests.input_tokens),
        output_tokens = COALESCE(excluded.output_tokens, requests.output_tokens),
        cached_input_tokens = COALESCE(excluded.cached_input_tokens, requests.cached_input_tokens)
    `).run(record.id, record.sessionId, record.model, record.recordedAt, day,
      record.inputTokens ?? null, record.outputTokens ?? null, record.cachedInputTokens ?? null);
  }

  snapshot(): UsageStatistics {
    this.#db.exec('BEGIN');
    try {
      const result = this.#readSnapshot();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  #readSnapshot(): UsageStatistics {
    const totals = this.#db.prepare(`SELECT
      COALESCE(SUM(input_tokens), 0) AS promptTokens,
      COALESCE(SUM(output_tokens), 0) AS completionTokens,
      COALESCE(SUM(cached_input_tokens), 0) AS promptCacheHitTokens,
      COUNT(*) AS requestCount, COUNT(DISTINCT session_id) AS conversationCount FROM requests`).get()!;
    const activity = this.#db.prepare(`SELECT day AS date,
      SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)) AS tokens,
      COUNT(*) AS requests FROM requests GROUP BY day ORDER BY day`).all()
      .map(row => ({ date: String(row.date), tokens: Number(row.tokens), requests: Number(row.requests) }));
    const activeDates = activity.filter(day => day.tokens > 0);
    let previous = Number.NaN, streak = 0, longestStreak = 0;
    for (const day of activeDates) {
      const current = Date.parse(`${day.date}T00:00:00Z`);
      streak = current - previous === 86_400_000 ? streak + 1 : 1;
      longestStreak = Math.max(streak, longestStreak);
      previous = current;
    }
    const promptTokens = Number(totals.promptTokens), completionTokens = Number(totals.completionTokens);
    const promptCacheHitTokens = Number(totals.promptCacheHitTokens);
    return {
      startedAt: String(this.#db.prepare("SELECT value FROM metadata WHERE key = 'started_at'").get()!.value),
      promptTokens, completionTokens, totalTokens: promptTokens + completionTokens,
      promptCacheHitTokens, promptCacheMissTokens: Math.max(0, promptTokens - promptCacheHitTokens),
      requestCount: Number(totals.requestCount), conversationCount: Number(totals.conversationCount),
      activeDays: activeDates.length, longestStreak, activity,
    };
  }

  close() { this.#db.close(); }
}
