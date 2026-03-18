import { DatabaseSync, StatementSync } from "node:sqlite";
import fs from "fs";
import path from "path";

// node:sqlite uses DatabaseSync (synchronous API, similar to better-sqlite3)

export interface SessionSnapshotRow {
  id: number;
  agent: string;
  session_key: string;
  session_id: string;
  model: string | null;
  provider: string | null;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  context_tokens: number;
  compaction_count: number;
  sampled_at: number;
}

export interface CostRecordRow {
  id: number;
  agent: string;
  session_key: string;
  date: string;
  input_tokens: number;
  output_tokens: number;
  model: string | null;
  estimated_usd: number;
  recorded_at: number;
}

export interface CompactEventRow {
  id: number;
  agent: string;
  session_key: string;
  compaction_entry_id: string;
  first_kept_entry_id: string;
  tokens_before: number | null;
  summary_text: string | null;
  compacted_at: number | null;
  compacted_message_count: number | null;
  compacted_messages: string | null;
}

export interface FileSnapshotRow {
  id: number;
  agent: string;
  file_path: string;
  raw_chars: number;
  injected_chars: number;
  was_truncated: number;
  sampled_at: number;
}

export interface SuggestionRow {
  id: number;
  agent: string;
  rule_id: string;
  severity: string;
  title: string;
  detail: string;
  action: string | null;
  created_at: number;
  dismissed: number;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS session_snapshots (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  agent            TEXT    NOT NULL,
  session_key      TEXT    NOT NULL,
  session_id       TEXT    NOT NULL,
  model            TEXT,
  provider         TEXT,
  input_tokens     INTEGER NOT NULL DEFAULT 0,
  output_tokens    INTEGER NOT NULL DEFAULT 0,
  total_tokens     INTEGER NOT NULL DEFAULT 0,
  context_tokens   INTEGER NOT NULL DEFAULT 0,
  compaction_count INTEGER NOT NULL DEFAULT 0,
  sampled_at       INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ss_agent_session ON session_snapshots(agent, session_key, sampled_at);

CREATE TABLE IF NOT EXISTS cost_records (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  agent         TEXT    NOT NULL,
  session_key   TEXT    NOT NULL,
  date          TEXT    NOT NULL,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  model         TEXT,
  estimated_usd REAL    NOT NULL DEFAULT 0,
  recorded_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cr_agent_date ON cost_records(agent, date);


CREATE TABLE IF NOT EXISTS compact_events (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  agent                   TEXT    NOT NULL,
  session_key             TEXT    NOT NULL,
  compaction_entry_id     TEXT    NOT NULL UNIQUE,
  first_kept_entry_id     TEXT    NOT NULL,
  tokens_before           INTEGER,
  summary_text            TEXT,
  compacted_at            INTEGER,
  compacted_message_count INTEGER,
  compacted_messages      TEXT
);

CREATE INDEX IF NOT EXISTS idx_ce_agent_session ON compact_events(agent, session_key);

CREATE TABLE IF NOT EXISTS file_snapshots (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  agent          TEXT    NOT NULL,
  file_path      TEXT    NOT NULL,
  raw_chars      INTEGER NOT NULL DEFAULT 0,
  injected_chars INTEGER NOT NULL DEFAULT 0,
  was_truncated  INTEGER NOT NULL DEFAULT 0,
  sampled_at     INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_fs_agent_path ON file_snapshots(agent, file_path, sampled_at);

CREATE TABLE IF NOT EXISTS suggestions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  agent      TEXT    NOT NULL,
  rule_id    TEXT    NOT NULL,
  severity   TEXT    NOT NULL,
  title      TEXT    NOT NULL,
  detail     TEXT    NOT NULL,
  action     TEXT,
  created_at INTEGER NOT NULL,
  dismissed  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sg_agent_rule ON suggestions(agent, rule_id, dismissed);
`;

let _db: DatabaseSync | null = null;

export function openDb(probeDir: string): DatabaseSync {
  if (_db) return _db;

  fs.mkdirSync(probeDir, { recursive: true });
  const dbPath = path.join(probeDir, "probe.db");
  _db = new DatabaseSync(dbPath);
  _db.exec(SCHEMA);
  migrateDb(_db);
  return _db;
}

/**
 * Run lightweight migrations for schema changes that can't be done with
 * CREATE TABLE IF NOT EXISTS (e.g. deduplicating existing rows before
 * adding a UNIQUE index, or adding columns to existing tables).
 */
function migrateDb(db: DatabaseSync): void {
  // v0.2.11: deduplicate cost_records before adding unique index
  try {
    // Remove duplicate rows, keeping only the one with the highest output_tokens per (agent, session_key, date)
    db.exec(`
      DELETE FROM cost_records
      WHERE id NOT IN (
        SELECT MAX(id) FROM cost_records
        GROUP BY agent, session_key, date
      )
    `);
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_cr_unique
      ON cost_records(agent, session_key, date)
    `);
  } catch {
    // If migration fails, the SELECT+UPDATE fallback in upsertCostRecord still works
  }
}

export function getDb(): DatabaseSync {
  if (!_db) throw new Error("Database not initialized. Call openDb() first.");
  return _db;
}

export function resetDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// --- Session Snapshots ---

export function insertSessionSnapshot(
  db: DatabaseSync,
  row: Omit<SessionSnapshotRow, "id">
): void {
  // INSERT OR REPLACE deduplicates same (agent, session_key, sampled_at) so that
  // if the daemon triggers twice in the same second we don't create duplicate rows
  // that would cause token deltas to be counted twice in recordDailyCost.
  db.prepare(`
    INSERT INTO session_snapshots
      (agent, session_key, session_id, model, provider,
       input_tokens, output_tokens, total_tokens, context_tokens,
       compaction_count, sampled_at)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent, session_key, sampled_at) DO UPDATE SET
      session_id       = excluded.session_id,
      model            = excluded.model,
      provider         = excluded.provider,
      input_tokens     = excluded.input_tokens,
      output_tokens    = excluded.output_tokens,
      total_tokens     = excluded.total_tokens,
      context_tokens   = excluded.context_tokens,
      compaction_count = excluded.compaction_count
  `).run(
    row.agent, row.session_key, row.session_id, row.model, row.provider,
    row.input_tokens, row.output_tokens, row.total_tokens, row.context_tokens,
    row.compaction_count, row.sampled_at
  );
}

export function getFirstSnapshot(
  db: DatabaseSync,
  agent: string,
  sessionKey: string
): SessionSnapshotRow | undefined {
  return db.prepare(`
    SELECT * FROM session_snapshots
    WHERE agent = ? AND session_key = ?
    ORDER BY sampled_at ASC
    LIMIT 1
  `).get(agent, sessionKey) as unknown as SessionSnapshotRow | undefined;
}

export function getLatestSnapshot(
  db: DatabaseSync,
  agent: string,
  sessionKey: string
): SessionSnapshotRow | undefined {
  return db.prepare(`
    SELECT * FROM session_snapshots
    WHERE agent = ? AND session_key = ?
    ORDER BY sampled_at DESC
    LIMIT 1
  `).get(agent, sessionKey) as unknown as SessionSnapshotRow | undefined;
}

export function getAllSnapshots(
  db: DatabaseSync,
  agent: string,
  sessionKey: string
): SessionSnapshotRow[] {
  return db.prepare(`
    SELECT * FROM session_snapshots
    WHERE agent = ? AND session_key = ?
    ORDER BY sampled_at ASC
  `).all(agent, sessionKey) as unknown as SessionSnapshotRow[];
}

export function getAllSessionKeys(
  db: DatabaseSync,
  agent: string
): { session_key: string; last_sampled_at: number }[] {
  return db.prepare(`
    SELECT session_key, MAX(sampled_at) as last_sampled_at
    FROM session_snapshots
    WHERE agent = ?
    GROUP BY session_key
    ORDER BY last_sampled_at DESC
  `).all(agent) as unknown as { session_key: string; last_sampled_at: number }[];
}

// --- Cost Records ---

export function upsertCostRecord(
  db: DatabaseSync,
  row: Omit<CostRecordRow, "id">
): void {
  // Use SELECT + UPDATE/INSERT to avoid relying on UNIQUE constraint
  // (which may not exist on older DBs created before v0.2.11).
  // We store the cumulative daily total per session, updating when the
  // new value is larger (so repeated scans don't double-count).
  const existing = db.prepare(`
    SELECT id, input_tokens, output_tokens, estimated_usd
    FROM cost_records
    WHERE agent = ? AND session_key = ? AND date = ?
    ORDER BY id DESC LIMIT 1
  `).get(row.agent, row.session_key, row.date) as
    { id: number; input_tokens: number; output_tokens: number; estimated_usd: number } | undefined;

  if (existing) {
    // Only update if the new value is larger (cumulative total grew)
    if (row.output_tokens > existing.output_tokens) {
      db.prepare(`
        UPDATE cost_records
        SET input_tokens = ?, output_tokens = ?, model = ?, estimated_usd = ?, recorded_at = ?
        WHERE id = ?
      `).run(
        row.input_tokens, row.output_tokens,
        row.model, row.estimated_usd, row.recorded_at,
        existing.id
      );
    }
  } else {
    db.prepare(`
      INSERT INTO cost_records
        (agent, session_key, date, input_tokens, output_tokens, model, estimated_usd, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.agent, row.session_key, row.date,
      row.input_tokens, row.output_tokens, row.model,
      row.estimated_usd, row.recorded_at
    );
  }
}

export function getDailyCostSummary(
  db: DatabaseSync,
  agent: string,
  days: number
): { date: string; total_usd: number; input_tokens: number; output_tokens: number }[] {
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  return db.prepare(`
    SELECT
      date,
      SUM(estimated_usd)  AS total_usd,
      SUM(input_tokens)   AS input_tokens,
      SUM(output_tokens)  AS output_tokens
    FROM cost_records
    WHERE agent = ? AND date >= ?
    GROUP BY date
    ORDER BY date ASC
  `).all(agent, cutoff) as unknown as { date: string; total_usd: number; input_tokens: number; output_tokens: number }[];
}

/**
 * Returns the raw per-session cost rows for a date range, including model name.
 * Used by getPeriodCost to recompute USD from live price table rather than
 * relying on the stored estimated_usd (which may have been recorded before
 * prices were available).
 */
export function getDailyCostRows(
  db: DatabaseSync,
  agent: string,
  days: number
): { date: string; session_key: string; model: string | null; input_tokens: number; output_tokens: number; estimated_usd: number }[] {
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  return db.prepare(`
    SELECT date, session_key, model, input_tokens, output_tokens, estimated_usd
    FROM cost_records
    WHERE agent = ? AND date >= ?
    ORDER BY date ASC
  `).all(agent, cutoff) as unknown as { date: string; session_key: string; model: string | null; input_tokens: number; output_tokens: number; estimated_usd: number }[];
}

// --- Compact Events ---

export function upsertCompactEvent(
  db: DatabaseSync,
  row: Omit<CompactEventRow, "id">
): void {
  db.prepare(`
    INSERT OR REPLACE INTO compact_events
      (agent, session_key, compaction_entry_id, first_kept_entry_id,
       tokens_before, summary_text, compacted_at,
       compacted_message_count, compacted_messages)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.agent, row.session_key, row.compaction_entry_id, row.first_kept_entry_id,
    row.tokens_before, row.summary_text, row.compacted_at,
    row.compacted_message_count, row.compacted_messages
  );
}

export function getCompactEvents(
  db: DatabaseSync,
  agent: string,
  limit: number,
  sessionKey?: string
): CompactEventRow[] {
  if (sessionKey) {
    return db.prepare(`
      SELECT * FROM compact_events
      WHERE agent = ? AND session_key = ?
      ORDER BY compacted_at DESC
      LIMIT ?
    `).all(agent, sessionKey, limit) as unknown as CompactEventRow[];
  }
  return db.prepare(`
    SELECT * FROM compact_events
    WHERE agent = ?
    ORDER BY compacted_at DESC
    LIMIT ?
  `).all(agent, limit) as unknown as CompactEventRow[];
}

export function getCompactEventById(
  db: DatabaseSync,
  id: number
): CompactEventRow | undefined {
  return db.prepare(`SELECT * FROM compact_events WHERE id = ?`).get(id) as unknown as CompactEventRow | undefined;
}

// --- File Snapshots ---

export function insertFileSnapshot(
  db: DatabaseSync,
  row: Omit<FileSnapshotRow, "id">
): void {
  // ON CONFLICT deduplicates same (agent, file_path, sampled_at) so repeated
  // snapshots within the same second don't produce phantom rows in context output.
  db.prepare(`
    INSERT INTO file_snapshots
      (agent, file_path, raw_chars, injected_chars, was_truncated, sampled_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent, file_path, sampled_at) DO UPDATE SET
      raw_chars      = excluded.raw_chars,
      injected_chars = excluded.injected_chars,
      was_truncated  = excluded.was_truncated
  `).run(
    row.agent, row.file_path, row.raw_chars,
    row.injected_chars, row.was_truncated, row.sampled_at
  );
}

export function getLatestFileSnapshots(
  db: DatabaseSync,
  agent: string
): FileSnapshotRow[] {
  // UNIQUE index on (agent, file_path, sampled_at) guarantees at most one row per
  // (file, second), so the simple MAX(sampled_at) join is always duplicate-free.
  return db.prepare(`
    SELECT fs.*
    FROM file_snapshots fs
    INNER JOIN (
      SELECT file_path, MAX(sampled_at) AS max_at
      FROM file_snapshots
      WHERE agent = ?
      GROUP BY file_path
    ) latest ON fs.file_path = latest.file_path AND fs.sampled_at = latest.max_at
    WHERE fs.agent = ?
    ORDER BY fs.raw_chars DESC
  `).all(agent, agent) as unknown as FileSnapshotRow[];
}

// --- Suggestions ---

export function upsertSuggestion(
  db: DatabaseSync,
  row: Omit<SuggestionRow, "id" | "dismissed">
): void {
  const existing = db.prepare(`
    SELECT id, dismissed FROM suggestions
    WHERE agent = ? AND rule_id = ?
  `).get(row.agent, row.rule_id) as unknown as { id: number; dismissed: number } | undefined;

  if (existing) {
    if (existing.dismissed) return;
    db.prepare(`
      UPDATE suggestions
      SET severity = ?, title = ?, detail = ?, action = ?, created_at = ?
      WHERE id = ?
    `).run(row.severity, row.title, row.detail, row.action, row.created_at, existing.id);
  } else {
    db.prepare(`
      INSERT INTO suggestions
        (agent, rule_id, severity, title, detail, action, created_at, dismissed)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0)
    `).run(row.agent, row.rule_id, row.severity, row.title, row.detail, row.action, row.created_at);
  }
}

export function getSuggestions(
  db: DatabaseSync,
  agent: string,
  severity?: string
): SuggestionRow[] {
  if (severity) {
    return db.prepare(`
      SELECT * FROM suggestions
      WHERE agent = ? AND dismissed = 0 AND severity = ?
      ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, created_at DESC
    `).all(agent, severity) as unknown as SuggestionRow[];
  }
  return db.prepare(`
    SELECT * FROM suggestions
    WHERE agent = ? AND dismissed = 0
    ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, created_at DESC
  `).all(agent) as unknown as SuggestionRow[];
}

export function dismissSuggestion(
  db: DatabaseSync,
  agent: string,
  ruleId: string
): void {
  db.prepare(`UPDATE suggestions SET dismissed = 1 WHERE agent = ? AND rule_id = ?`).run(agent, ruleId);
}

export function resetDismissed(db: DatabaseSync, agent: string): void {
  db.prepare(`UPDATE suggestions SET dismissed = 0 WHERE agent = ?`).run(agent);
}

export function removeSuggestion(
  db: DatabaseSync,
  agent: string,
  ruleId: string
): void {
  db.prepare(`DELETE FROM suggestions WHERE agent = ? AND rule_id = ?`).run(agent, ruleId);
}
