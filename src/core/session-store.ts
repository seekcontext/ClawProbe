import fs from "fs";
import path from "path";

export interface SessionEntry {
  sessionId: string;
  sessionKey: string;
  updatedAt: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  contextTokens: number;
  compactionCount: number;
  memoryFlushAt?: number;
  modelOverride?: string;
  providerOverride?: string;
}

export interface SessionsStore {
  sessions: Record<string, RawSessionEntry>;
}

interface RawSessionEntry {
  sessionId?: string;
  updatedAt?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  contextTokens?: number;
  compactionCount?: number;
  memoryFlushAt?: number;
  modelOverride?: string;
  providerOverride?: string;
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

  return {
    sessionKey,
    sessionId: raw.sessionId ?? sessionKey,
    updatedAt: raw.updatedAt ?? 0,
    inputTokens: raw.inputTokens ?? 0,
    outputTokens: raw.outputTokens ?? 0,
    totalTokens: raw.totalTokens ?? (raw.inputTokens ?? 0) + (raw.outputTokens ?? 0),
    contextTokens: raw.contextTokens ?? 0,
    compactionCount: raw.compactionCount ?? 0,
    memoryFlushAt: raw.memoryFlushAt,
    modelOverride: raw.modelOverride,
    providerOverride: raw.providerOverride,
  };
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
