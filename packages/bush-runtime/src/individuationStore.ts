import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { CheckHabitInput, IndividuationSettings, SummaryForUserInput } from '@cardbush/bush-protocol';

type Owner = { sessionId: string; turnId: string };
type RecordRow = { id: string; key: string; body: string; session_id: string; turn_id: string;
  updated_at: number; status: string; claimed_session: string | null; claimed_turn: string | null };
const idFor = (kind: string, key: string) => `${kind}_${createHash('sha256').update(key.toLowerCase()).digest('hex').slice(0, 24)}`;

/** Per-user runtime database, opened only for explicitly enabled operations. */
export class IndividuationStore {
  constructor(private readonly path: string, private readonly now = Date.now) {}

  private async transaction<T>(settings: IndividuationSettings, run: (db: DatabaseSync, now: number) => T, signal?: AbortSignal): Promise<T> {
    // Lazy import keeps the always-available final-answer signal independent of SQLite.
    const { DatabaseSync } = await import('node:sqlite');
    signal?.throwIfAborted();
    if (this.path !== ':memory:') {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      try { closeSync(openSync(this.path, 'ax', 0o600)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    const db = new DatabaseSync(this.path);
    let inTransaction = false;
    try {
      db.exec(`PRAGMA busy_timeout = 5000;
        CREATE TABLE IF NOT EXISTS individuation (
          id TEXT PRIMARY KEY, kind TEXT NOT NULL, key TEXT NOT NULL, body TEXT NOT NULL,
          session_id TEXT NOT NULL, turn_id TEXT NOT NULL, updated_at INTEGER NOT NULL,
          expires_at INTEGER, status TEXT NOT NULL DEFAULT 'pending', claimed_session TEXT, claimed_turn TEXT);
        CREATE INDEX IF NOT EXISTS individuation_recent ON individuation(kind, updated_at DESC);`);
      db.exec('BEGIN IMMEDIATE');
      inTransaction = true;
      const now = this.now();
      // Retain claimed items: an interrupted action must not silently become eligible again.
      if (settings.predictions) db.prepare("DELETE FROM individuation WHERE expires_at <= ? AND status != 'claimed'").run(now);
      const result = run(db, now);
      for (const kind of [...(settings.habits ? ['habit'] : []), ...(settings.predictions ? ['prediction'] : [])]) {
        db.prepare(`DELETE FROM individuation WHERE kind = ? AND status != 'claimed' AND id NOT IN
          (SELECT id FROM individuation WHERE kind = ? AND status != 'claimed' ORDER BY updated_at DESC, id
            LIMIT MAX(0, 1000 - (SELECT COUNT(*) FROM individuation WHERE kind = ? AND status = 'claimed')))`)
          .run(kind, kind, kind);
      }
      db.exec('COMMIT');
      inTransaction = false;
      return result;
    } catch (error) {
      if (inTransaction) db.exec('ROLLBACK');
      throw error;
    } finally { db.close(); }
  }

  async summarize(input: SummaryForUserInput, settings: IndividuationSettings, owner: Owner, signal?: AbortSignal) {
    const empty = { habit_ids: [] as string[], prediction_ids: [] as string[], consumed_prediction_ids: [] as string[] };
    if (!(settings.habits && input.habits.length) &&
        !(settings.predictions && (input.predictions.length || input.consumed_prediction_ids.length))) return empty;
    return this.transaction(settings, (db, now) => {
      if (settings.habits) for (const habit of input.habits) {
        const id = idFor('habit', habit.key);
        db.prepare(`INSERT INTO individuation(id, kind, key, body, session_id, turn_id, updated_at)
          VALUES(?, 'habit', ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
          body=excluded.body, session_id=excluded.session_id, turn_id=excluded.turn_id, updated_at=excluded.updated_at`)
          .run(id, habit.key, JSON.stringify(habit), owner.sessionId, owner.turnId, now);
        empty.habit_ids.push(id);
      }
      if (settings.predictions) {
        for (const prediction of input.predictions) {
          const id = idFor('prediction', prediction.key);
          const changed = db.prepare(`INSERT INTO individuation(id, kind, key, body, session_id, turn_id, updated_at, expires_at)
            VALUES(?, 'prediction', ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
            body=excluded.body, session_id=excluded.session_id, turn_id=excluded.turn_id,
            updated_at=excluded.updated_at, expires_at=excluded.expires_at WHERE individuation.status='pending'`)
            .run(id, prediction.key, JSON.stringify(prediction), owner.sessionId, owner.turnId, now,
              now + prediction.expires_in_days * 86_400_000);
          if (changed.changes) empty.prediction_ids.push(id);
        }
        for (const id of input.consumed_prediction_ids) {
          const row = db.prepare(`UPDATE individuation SET status='consumed', updated_at=? WHERE id=?
            AND kind='prediction' AND status='claimed' AND claimed_session=?`)
            .run(now, id, owner.sessionId);
          if (row.changes) empty.consumed_prediction_ids.push(id);
        }
      }
      return empty;
    }, signal);
  }

  async check(input: CheckHabitInput, settings: IndividuationSettings, owner: Owner, signal?: AbortSignal) {
    const empty = { habits: [] as unknown[], predictions: [] as unknown[], claimed_prediction_ids: [] as string[], released_prediction_ids: [] as string[] };
    if (!settings.habits && !settings.predictions) return empty;
    return this.transaction(settings, (db, now) => {
      if (settings.predictions) {
        for (const id of input.release_prediction_ids) {
          // A later turn in the same conversation can resolve an interrupted claim.
          // It must verify the prior outcome before releasing or consuming it.
          if (db.prepare(`UPDATE individuation SET status='pending', claimed_session=NULL, claimed_turn=NULL
            WHERE id=? AND kind='prediction' AND status='claimed' AND claimed_session=?`)
            .run(id, owner.sessionId).changes) empty.released_prediction_ids.push(id);
        }
        for (const id of input.claim_prediction_ids) {
          db.prepare(`UPDATE individuation SET status='claimed', claimed_session=?, claimed_turn=?
            WHERE id=? AND kind='prediction' AND status='pending' AND expires_at>?
            AND (SELECT COUNT(*) FROM individuation WHERE status='claimed') < 100`)
            .run(owner.sessionId, owner.turnId, id, now);
          const claimed = db.prepare(`SELECT id FROM individuation WHERE id=? AND status='claimed'
            AND claimed_session=? AND claimed_turn=?`).get(id, owner.sessionId, owner.turnId);
          if (claimed) empty.claimed_prediction_ids.push(id);
        }
      }
      const pattern = `%${input.query.replace(/[\\%_]/g, '\\$&')}%`;
      const list = (kind: string) => (db.prepare(`SELECT * FROM individuation WHERE kind=?
        AND status!='consumed' AND (key LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')
        ORDER BY updated_at DESC, id LIMIT ?`).all(kind, pattern, pattern, input.limit) as unknown as RecordRow[])
        .map(row => ({ id: row.id, ...JSON.parse(row.body), status: row.status,
          source_session_id: row.session_id, source_turn_id: row.turn_id,
          updated_at: new Date(row.updated_at).toISOString(),
          ...(row.claimed_session ? { claimed_by: { session_id: row.claimed_session, turn_id: row.claimed_turn },
            claimed_by_this_session: row.claimed_session === owner.sessionId,
            claimed_by_this_turn: row.claimed_session === owner.sessionId && row.claimed_turn === owner.turnId } : {}) }));
      if (settings.habits) empty.habits = list('habit');
      if (settings.predictions) empty.predictions = list('prediction');
      return empty;
    }, signal);
  }
}
