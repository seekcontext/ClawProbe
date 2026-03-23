import { DatabaseSync } from "node:sqlite";
import fs from "fs";
import path from "path";

// ---------------------------------------------------------------------------
// Row interfaces
// ---------------------------------------------------------------------------

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

/**
 * One row per assistant turn, keyed by (agent, session_key, turn_index).
 * Stores the raw token breakdown reported by the model so that cost can be
 * recomputed accurately at any time with the current price table.
 *
 * Billing semantics (matches provider invoices):
 *   cost = (input - cache_read - cache_write) * input_price
 *        + output * output_price
 *        + cache_read  * input_price * cacheReadMultiplier
 *        + cache_write * input_price * cacheWriteMultiplier
 */
export interface TurnRecordRow {
  id: number;
  agent: string;
  session_key: string;
  /** YYYY-MM-DD of the turn, in local timezone */
  date: string;
  /** 1-based index within the session */
  turn_index: number;
  /** Unix seconds */
  sampled_at: number;
  model: string | null;
  provider: string | null;
  /** Full context tokens sent this turn (billed as input by provider) */
  input_tokens: number;
  /** Tokens generated this turn */
  output_tokens: number;
  /** Tokens served from prompt cache (billed at discounted rate) */
  cache_read: number;
  /** Tokens written to prompt cache */
  cache_write: number;
  /** Pre-computed USD cost for this turn, stored for fast aggregation */
  estimated_usd: number;
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

export interface ToolStatRow {
  id: number;
  agent: string;
  session_key: string;
  tool_name: string;
  call_count: number;
  error_count: number;
  sampled_at: number;
}

export interface TodoSnapshotRow {
  id: number;
  agent: string;
  session_key: string;
  /** JSON array of TodoItem */
  todos_json: string;
  sampled_at: number;
}

export interface AgentStatRow {
  id: number;
  agent: string;
  session_key: string;
  sub_id: string;
  sub_type: string;
  model: string | null;
  description: string | null;
  sampled_at: number;
}

// ---------------------------------------------------------------------------
// Schema  (v0.5 — replaces cost_records with turn_records)
// ---------------------------------------------------------------------------

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

CREATE UNIQUE INDEX IF NOT EXISTS idx_ss_agent_session
  ON session_snapshots(agent, session_key, sampled_at);

-- Per-turn token records — the single source of truth for cost.
-- Replacing the old cost_records table which discarded cache token info.
CREATE TABLE IF NOT EXISTS turn_records (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  agent         TEXT    NOT NULL,
  session_key   TEXT    NOT NULL,
  date          TEXT    NOT NULL,
  turn_index    INTEGER NOT NULL,
  sampled_at    INTEGER NOT NULL,
  model         TEXT,
  provider      TEXT,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read    INTEGER NOT NULL DEFAULT 0,
  cache_write   INTEGER NOT NULL DEFAULT 0,
  estimated_usd REAL    NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tr_agent_session_turn
  ON turn_records(agent, session_key, turn_index);

CREATE INDEX IF NOT EXISTS idx_tr_agent_date
  ON turn_records(agent, date);

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

CREATE UNIQUE INDEX IF NOT EXISTS idx_fs_agent_path
  ON file_snapshots(agent, file_path, sampled_at);

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

CREATE TABLE IF NOT EXISTS tool_stats (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent       TEXT    NOT NULL,
  session_key TEXT    NOT NULL,
  tool_name   TEXT    NOT NULL,
  call_count  INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  sampled_at  INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tst_agent_session_tool
  ON tool_stats(agent, session_key, tool_name);

CREATE TABLE IF NOT EXISTS todo_snapshots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent       TEXT    NOT NULL,
  session_key TEXT    NOT NULL,
  todos_json  TEXT    NOT NULL,
  sampled_at  INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_td_agent_session
  ON todo_snapshots(agent, session_key);

CREATE TABLE IF NOT EXISTS agent_stats (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent       TEXT    NOT NULL,
  session_key TEXT    NOT NULL,
  sub_id      TEXT    NOT NULL,
  sub_type    TEXT    NOT NULL,
  model       TEXT,
  description TEXT,
  sampled_at  INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ag_sub_id
  ON agent_stats(sub_id);

CREATE INDEX IF NOT EXISTS idx_ag_agent_session
  ON agent_stats(agent, session_key);
`;

// ---------------------------------------------------------------------------
// DB lifecycle
// ---------------------------------------------------------------------------

let _db: DatabaseSync | null = null;

export function openDb(probeDir: string): DatabaseSync {
  if (_db) return _db;

  fs.mkdirSync(probeDir, { recursive: true });
  const dbPath = path.join(probeDir, "probe.db");
  _db = new DatabaseSync(dbPath);
  _db.exec(SCHEMA);
  return _db;
}

/**
 * Delete the probe.db file and reset the in-memory handle.
 * The next call to openDb() will recreate a fresh database.
 */
export function dropAndResetDb(probeDir: string): void {
  if (_db) {
    _db.close();
    _db = null;
  }
  const dbPath = path.join(probeDir, "probe.db");
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
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

// ---------------------------------------------------------------------------
// Session Snapshots
// ---------------------------------------------------------------------------

export function insertSessionSnapshot(
  db: DatabaseSync,
  row: Omit<SessionSnapshotRow, "id">
): void {
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

// ---------------------------------------------------------------------------
// Turn Records  (replaces cost_records)
// ---------------------------------------------------------------------------

export function upsertTurnRecord(
  db: DatabaseSync,
  row: Omit<TurnRecordRow, "id">
): void {
  db.prepare(`
    INSERT INTO turn_records
      (agent, session_key, date, turn_index, sampled_at, model, provider,
       input_tokens, output_tokens, cache_read, cache_write, estimated_usd)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent, session_key, turn_index) DO UPDATE SET
      date          = excluded.date,
      sampled_at    = excluded.sampled_at,
      model         = excluded.model,
      provider      = excluded.provider,
      input_tokens  = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      cache_read    = excluded.cache_read,
      cache_write   = excluded.cache_write,
      estimated_usd = excluded.estimated_usd
  `).run(
    row.agent, row.session_key, row.date, row.turn_index, row.sampled_at,
    row.model, row.provider,
    row.input_tokens, row.output_tokens, row.cache_read, row.cache_write,
    row.estimated_usd
  );
}

/**
 * Return per-date aggregated token counts for the cost summary view.
 * estimated_usd is the stored value; callers may recompute from token columns.
 */
export function getTurnSummaryByDate(
  db: DatabaseSync,
  agent: string,
  days: number
): { date: string; input_tokens: number; output_tokens: number; cache_read: number; cache_write: number; model: string | null; estimated_usd: number }[] {
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  // Group by date + model so the caller can apply the correct per-model price.
  // Use MAX(model) as a tiebreaker when a session switches models within a day.
  return db.prepare(`
    SELECT
      date,
      SUM(input_tokens)  AS input_tokens,
      SUM(output_tokens) AS output_tokens,
      SUM(cache_read)    AS cache_read,
      SUM(cache_write)   AS cache_write,
      model,
      SUM(estimated_usd) AS estimated_usd
    FROM turn_records
    WHERE agent = ? AND date >= ?
    GROUP BY date, model
    ORDER BY date ASC
  `).all(agent, cutoff) as unknown as { date: string; input_tokens: number; output_tokens: number; cache_read: number; cache_write: number; model: string | null; estimated_usd: number }[];
}

/**
 * Return raw per-turn rows for a date range.
 * Used by getPeriodCost to recompute USD with the live price table.
 */
export function getTurnRows(
  db: DatabaseSync,
  agent: string,
  days: number
): TurnRecordRow[] {
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  return db.prepare(`
    SELECT *
    FROM turn_records
    WHERE agent = ? AND date >= ?
    ORDER BY date ASC, sampled_at ASC
  `).all(agent, cutoff) as unknown as TurnRecordRow[];
}

// ---------------------------------------------------------------------------
// Compact Events
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// File Snapshots
// ---------------------------------------------------------------------------

export function insertFileSnapshot(
  db: DatabaseSync,
  row: Omit<FileSnapshotRow, "id">
): void {
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

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tool Stats
// ---------------------------------------------------------------------------

export function upsertToolStats(
  db: DatabaseSync,
  agent: string,
  sessionKey: string,
  toolName: string,
  callCount: number,
  errorCount: number,
  sampledAt: number
): void {
  db.prepare(`
    INSERT INTO tool_stats (agent, session_key, tool_name, call_count, error_count, sampled_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent, session_key, tool_name) DO UPDATE SET
      call_count  = excluded.call_count,
      error_count = excluded.error_count,
      sampled_at  = excluded.sampled_at
  `).run(agent, sessionKey, toolName, callCount, errorCount, sampledAt);
}

export function getToolStats(
  db: DatabaseSync,
  agent: string,
  sessionKey: string
): ToolStatRow[] {
  return db.prepare(`
    SELECT * FROM tool_stats
    WHERE agent = ? AND session_key = ?
    ORDER BY call_count DESC
  `).all(agent, sessionKey) as unknown as ToolStatRow[];
}

// ---------------------------------------------------------------------------
// Todo Snapshots
// ---------------------------------------------------------------------------

export function upsertTodoSnapshot(
  db: DatabaseSync,
  agent: string,
  sessionKey: string,
  todosJson: string,
  sampledAt: number
): void {
  db.prepare(`
    INSERT INTO todo_snapshots (agent, session_key, todos_json, sampled_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(agent, session_key) DO UPDATE SET
      todos_json = excluded.todos_json,
      sampled_at = excluded.sampled_at
  `).run(agent, sessionKey, todosJson, sampledAt);
}

export function getTodoSnapshot(
  db: DatabaseSync,
  agent: string,
  sessionKey: string
): TodoSnapshotRow | undefined {
  return db.prepare(`
    SELECT * FROM todo_snapshots WHERE agent = ? AND session_key = ?
  `).get(agent, sessionKey) as unknown as TodoSnapshotRow | undefined;
}

// ---------------------------------------------------------------------------
// Agent Stats (sub-agent invocations)
// ---------------------------------------------------------------------------

export function upsertAgentStat(
  db: DatabaseSync,
  agent: string,
  sessionKey: string,
  row: { sub_id: string; sub_type: string; model: string | null; description: string | null; sampled_at: number }
): void {
  db.prepare(`
    INSERT INTO agent_stats (agent, session_key, sub_id, sub_type, model, description, sampled_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sub_id) DO UPDATE SET
      sub_type    = excluded.sub_type,
      model       = excluded.model,
      description = excluded.description,
      sampled_at  = excluded.sampled_at
  `).run(agent, sessionKey, row.sub_id, row.sub_type, row.model, row.description, row.sampled_at);
}

export function getAgentStats(
  db: DatabaseSync,
  agent: string,
  sessionKey: string
): AgentStatRow[] {
  return db.prepare(`
    SELECT * FROM agent_stats
    WHERE agent = ? AND session_key = ?
    ORDER BY sampled_at ASC
  `).all(agent, sessionKey) as unknown as AgentStatRow[];
}
