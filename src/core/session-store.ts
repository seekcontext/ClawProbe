import fs from "fs";
import path from "path";

export interface SessionEntry {
  sessionId: string;
  sessionKey: string;
  /** Path or UUID of the .jsonl transcript (from sessionFile field in sessions.json) */
  sessionFile?: string;
  updatedAt: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Actual tokens currently in context window (session_tokens / total in /context detail) */
  sessionTokens: number;
  /** Context window size upper limit (ctx= field, i.e. model max context) */
  windowSize: number;
  /**
   * @deprecated Use sessionTokens for actual usage, windowSize for the limit.
   * Kept for backward compatibility — may equal windowSize (not actual usage).
   */
  contextTokens: number;
  compactionCount: number;
  memoryFlushAt?: number;
  modelOverride?: string;
  providerOverride?: string;
}

export interface SessionsStore {
  sessions: Record<string, RawSessionEntry>;
}

// OpenClaw may write camelCase or snake_case; some versions nest under state/metrics.
interface RawSessionEntry {
  sessionId?: string;
  /** Path or UUID of the .jsonl transcript file (OpenClaw runtime field) */
  sessionFile?: string;
  updatedAt?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  contextTokens?: number;
  // session_tokens = actual tokens currently in context (from /context detail "Session tokens (cached)")
  sessionTokens?: number;
  session_tokens?: number;
  // ctx_size = context window upper limit
  ctxSize?: number;
  ctx_size?: number;
  compactionCount?: number;
  memoryFlushAt?: number;
  modelOverride?: string;
  providerOverride?: string;
  // Direct model/provider fields (used by some OpenClaw versions instead of modelOverride)
  model?: string;
  modelProvider?: string;
  // snake_case (e.g. OpenClaw runtime)
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  context_tokens?: number;
  compaction_count?: number;
  memory_flush_at?: number;
  model_override?: string;
  provider_override?: string;
  state?: Record<string, unknown>;
  metrics?: Record<string, unknown>;
}

export function readSessionsStore(sessionsDir: string): SessionEntry[] {
  const storePath = path.join(sessionsDir, "sessions.json");
  if (!fs.existsSync(storePath)) return [];

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(storePath, "utf-8"));
  } catch {
    return [];
  }

  if (!raw || typeof raw !== "object") return [];

  const store = raw as Record<string, unknown>;

  // sessions.json can have different shapes depending on OpenClaw version.
  // Shape 1: { sessions: { [sessionKey]: {...} } }
  // Shape 2: { [sessionKey]: {...} }
  const sessionsMap: Record<string, RawSessionEntry> =
    "sessions" in store && typeof store["sessions"] === "object"
      ? (store["sessions"] as Record<string, RawSessionEntry>)
      : (store as Record<string, RawSessionEntry>);

  return Object.entries(sessionsMap)
    .map(([sessionKey, entry]) => normalizeEntry(sessionKey, entry))
    .filter((e): e is SessionEntry => e !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function normalizeEntry(
  sessionKey: string,
  raw: RawSessionEntry
): SessionEntry | null {
  if (!raw || typeof raw !== "object") return null;

  // Prefer top-level, then state, then metrics (OpenClaw version-dependent)
  const state = (raw.state && typeof raw.state === "object" ? raw.state : {}) as Record<string, unknown>;
  const metrics = (raw.metrics && typeof raw.metrics === "object" ? raw.metrics : {}) as Record<string, unknown>;
  const sources = [raw as Record<string, unknown>, state, metrics];

  const inputTokens = getFirstNum(sources, "inputTokens", "input_tokens");
  const outputTokens = getFirstNum(sources, "outputTokens", "output_tokens");
  const totalTokens = getFirstNum(sources, "totalTokens", "total_tokens") || inputTokens + outputTokens;

  // contextTokens in sessions.json is actually the window size upper limit (ctx=256000),
  // NOT the actual current usage. The actual usage is in session_tokens field.
  const contextTokens = getFirstNum(sources, "contextTokens", "context_tokens");

  // sessionTokens = actual tokens in context right now (matches "Session tokens (cached)" in /context detail)
  // Try several field names OpenClaw may use
  const sessionTokens = getFirstNum(sources, "sessionTokens", "session_tokens");

  // windowSize = context window upper limit (ctx= value)
  const windowSize = getFirstNum(sources, "ctxSize", "ctx_size") || contextTokens;

  const compactionCount = getFirstNum(sources, "compactionCount", "compaction_count");
  let updatedAt = getFirstNum(sources, "updatedAt", "updated_at");
  if (updatedAt === 0) {
    const ts = getFirst(sources, "updatedAt", "updated_at", "lastActive");
    if (typeof ts === "number") updatedAt = ts;
    if (typeof ts === "string") updatedAt = Math.floor(new Date(ts).getTime() / 1000) || 0;
  }

  const sessionId = (getFirst(sources, "sessionId", "session_id") as string | undefined) ?? sessionKey;
  const sessionFile = raw.sessionFile as string | undefined;
  // Support direct model/modelProvider fields in addition to modelOverride/providerOverride
  const modelOverride = (raw.modelOverride ?? raw.model_override ?? raw.model) as string | undefined;
  const providerOverride = (raw.providerOverride ?? raw.provider_override ?? raw.modelProvider) as string | undefined;

  return {
    sessionKey,
    sessionId,
    sessionFile,
    updatedAt,
    inputTokens,
    outputTokens,
    totalTokens,
    sessionTokens,
    windowSize,
    contextTokens,
    compactionCount,
    memoryFlushAt: (raw.memoryFlushAt ?? raw.memory_flush_at) as number | undefined,
    modelOverride,
    providerOverride,
  };
}

function getFirstNum(sources: Record<string, unknown>[], ...keyVariants: string[]): number {
  for (const src of sources) {
    for (const key of keyVariants) {
      const v = src[key];
      if (typeof v === "number" && !Number.isNaN(v)) return v;
    }
  }
  return 0;
}

function getFirst(
  sources: Record<string, unknown>[],
  ...keyVariants: string[]
): unknown {
  for (const src of sources) {
    for (const key of keyVariants) {
      if (key in src) return src[key];
    }
  }
  return undefined;
}

export function getSession(sessionsDir: string, sessionKey: string): SessionEntry | undefined {
  return readSessionsStore(sessionsDir).find((s) => s.sessionKey === sessionKey);
}

export function getActiveSession(sessionsDir: string): SessionEntry | undefined {
  const sessions = readSessionsStore(sessionsDir);
  if (sessions.length === 0) return undefined;
  // Most recently updated session is assumed to be active
  return sessions[0];
}

export function listJsonlFiles(sessionsDir: string): string[] {
  if (!fs.existsSync(sessionsDir)) return [];
  return fs
    .readdirSync(sessionsDir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => path.join(sessionsDir, f));
}

export function sessionKeyFromPath(filePath: string): string {
  return path.basename(filePath, ".jsonl");
}

/** UUID pattern for detection */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Build a map of session UUID → jsonl path by reading the first line of each .jsonl file.
 * Cached per sessionsDir invocation within a single process run.
 */
const _jsonlUuidCache = new Map<string, Map<string, string>>();

function buildUuidToPathMap(sessionsDir: string): Map<string, string> {
  const cached = _jsonlUuidCache.get(sessionsDir);
  if (cached) return cached;

  const map = new Map<string, string>();
  for (const jsonlPath of listJsonlFiles(sessionsDir)) {
    try {
      const fd = fs.openSync(jsonlPath, "r");
      const buf = Buffer.allocUnsafe(512);
      const bytesRead = fs.readSync(fd, buf, 0, 512, 0);
      fs.closeSync(fd);
      const firstLine = buf.slice(0, bytesRead).toString("utf-8").split("\n")[0] ?? "";
      const header = JSON.parse(firstLine) as Record<string, unknown>;
      if (header["type"] === "session" && typeof header["id"] === "string") {
        map.set(header["id"] as string, jsonlPath);
      }
    } catch { /* skip */ }
  }

  _jsonlUuidCache.set(sessionsDir, map);
  return map;
}

/**
 * Find the .jsonl transcript for a given session entry.
 *
 * OpenClaw names transcript files by the session UUID (e.g. 928a9cc3-...jsonl),
 * while sessions.json keys sessions by a human-readable key like
 * "agent:main:feishu:direct:ou_xxx".
 *
 * Strategy:
 * 1. Try sessionsDir/{sessionId}.jsonl  — if sessionId looks like a UUID
 * 2. Try sessionsDir/{sessionKey}.jsonl — for UUID-style sessionKey
 * 3. Check if any UUID in the sessions.json entry value matches a known jsonl UUID
 * 4. Scan all .jsonl first lines (via cached map) for the most recently modified
 *    file whose session.id appears as any string value in the entry's raw data
 */
export function findJsonlPath(sessionsDir: string, entry: SessionEntry): string | null {
  // Strategy 1a: sessionFile field (OpenClaw writes the UUID path here directly)
  if (entry.sessionFile) {
    // sessionFile may be a full path or just the UUID filename
    if (fs.existsSync(entry.sessionFile)) return entry.sessionFile;
    const basename = path.basename(entry.sessionFile);
    // Strip any extension variants and try as plain UUID
    const uuid = basename.replace(/\.jsonl.*$/, "");
    const p = path.join(sessionsDir, `${uuid}.jsonl`);
    if (fs.existsSync(p)) return p;
  }

  // Strategy 1b: sessionId looks like a UUID — use it directly as filename
  if (entry.sessionId && UUID_RE.test(entry.sessionId)) {
    const p = path.join(sessionsDir, `${entry.sessionId}.jsonl`);
    if (fs.existsSync(p)) return p;
  }

  // Strategy 2: sessionKey itself might be a UUID filename
  if (UUID_RE.test(entry.sessionKey)) {
    const p = path.join(sessionsDir, `${entry.sessionKey}.jsonl`);
    if (fs.existsSync(p)) return p;
  }

  // Strategy 3: Use cached UUID→path map (reads first line of each jsonl).
  // Match sessionId or sessionKey against the session header id in each file.
  const uuidMap = buildUuidToPathMap(sessionsDir);

  if (entry.sessionId && uuidMap.has(entry.sessionId)) {
    return uuidMap.get(entry.sessionId)!;
  }
  if (uuidMap.has(entry.sessionKey)) {
    return uuidMap.get(entry.sessionKey)!;
  }

  return null;
}

/**
 * Clear the UUID→path cache (call after daemon writes new files).
 */
export function clearJsonlCache(): void {
  _jsonlUuidCache.clear();
}
