import fs from "fs";
import path from "path";

export interface SessionEntry {
  sessionId: string;
  sessionKey: string;
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

  return {
    sessionKey,
    sessionId,
    updatedAt,
    inputTokens,
    outputTokens,
    totalTokens,
    sessionTokens,
    windowSize,
    contextTokens,
    compactionCount,
    memoryFlushAt: (raw.memoryFlushAt ?? raw.memory_flush_at) as number | undefined,
    modelOverride: (raw.modelOverride ?? raw.model_override) as string | undefined,
    providerOverride: (raw.providerOverride ?? raw.provider_override) as string | undefined,
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
