import fs from "fs";

// --- Entry Types ---

export interface SessionHeader {
  type: "session";
  id: string;
  cwd: string;
  timestamp: string | number;
  parentSession?: string;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}

export interface MessageEntry {
  type: "message";
  id: string;
  parentId: string;
  timestamp: string;
  message: {
    role: "user" | "assistant" | "tool" | "toolResult";
    content: unknown[];
    api?: string;
    provider?: string;
    model?: string;
    usage?: TokenUsage;
    stopReason?: string;
    errorMessage?: string;
    timestamp?: number;
  };
  // Convenience accessors for backward compatibility with code that accesses role/content directly
  role: "user" | "assistant" | "tool" | "toolResult";
  /** Text content extracted from the first text block, or stringified JSON */
  content: string;
}

export interface CompactionEntry {
  type: "compaction";
  id: string;
  parentId: string;
  firstKeptEntryId: string;
  tokensBefore?: number;
  content?: string;
  summaryText?: string;
  timestamp?: string;
}

export interface CustomEntry {
  type: "custom";
  customType: string;
  id: string;
  parentId?: string;
  timestamp: string;
  data?: Record<string, unknown>;
}

export type JournalEntry =
  | SessionHeader
  | MessageEntry
  | CompactionEntry
  | CustomEntry
  | { type: string; [key: string]: unknown };

// --- Compact analysis structures ---

export interface CompactEvent {
  entryId: string;
  parentId: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  summaryText: string;
  timestamp?: number;
  lineIndex: number;
}

// --- Per-turn stats (derived from a single assistant message) ---

export interface TurnStats {
  turnIndex: number;
  /** Unix seconds */
  timestamp: number;
  model: string | null;
  provider: string | null;
  usage: TokenUsage;
  stopReason: string;
  isError: boolean;
  toolCallCount: number;
}

// --- Session-level stats derived from jsonl ---

export interface SessionStats {
  sessionId: string;
  /** Unix seconds */
  startedAt: number;
  /** Unix seconds of last message */
  lastActiveAt: number;
  model: string | null;
  provider: string | null;
  /** Total input tokens across all turns (non-error) */
  totalInput: number;
  /** Total output tokens across all turns (non-error) */
  totalOutput: number;
  /** Total cache-read tokens */
  totalCacheRead: number;
  /** Total tokens in last successful assistant turn (= current context usage) */
  lastTotalTokens: number;
  /** Number of user turns */
  userTurns: number;
  /** Number of successful assistant turns */
  assistantTurns: number;
  /** Number of error turns */
  errorTurns: number;
  /** Number of tool calls across all turns */
  toolCallCount: number;
  /** Number of compaction events */
  compactionCount: number;
  turns: TurnStats[];
}

export interface ParseResult {
  entries: JournalEntry[];
  compactEvents: CompactEvent[];
}

// --- Incremental cursor state ---

const fileCursors = new Map<string, number>();

export function parseAll(filePath: string): ParseResult {
  fileCursors.delete(filePath);
  return parseIncremental(filePath);
}

export function parseIncremental(filePath: string): ParseResult {
  if (!fs.existsSync(filePath)) {
    return { entries: [], compactEvents: [] };
  }

  const fd = fs.openSync(filePath, "r");
  const stat = fs.fstatSync(fd);
  const fileSize = stat.size;

  const cursor = fileCursors.get(filePath) ?? 0;
  if (cursor >= fileSize) {
    fs.closeSync(fd);
    return { entries: [], compactEvents: [] };
  }

  const chunkSize = fileSize - cursor;
  const buf = Buffer.allocUnsafe(chunkSize);
  fs.readSync(fd, buf, 0, chunkSize, cursor);
  fs.closeSync(fd);

  fileCursors.set(filePath, fileSize);

  const newText = buf.toString("utf-8");
  const lines = newText.split("\n").filter((l) => l.trim().length > 0);

  const entries: JournalEntry[] = [];
  const compactEvents: CompactEvent[] = [];

  let lineIndex = 0;
  for (const line of lines) {
    try {
      const raw = JSON.parse(line) as Record<string, unknown>;
      const entry = raw as JournalEntry;

      // Populate convenience fields on MessageEntry
      if (raw["type"] === "message" && raw["message"]) {
        const msg = raw["message"] as Record<string, unknown>;
        const role = msg["role"] as string ?? "user";
        const content = msg["content"] as unknown[] ?? [];
        const textContent = content
          .filter((c) => (c as Record<string, unknown>)["type"] === "text")
          .map((c) => (c as Record<string, unknown>)["text"] as string)
          .join("\n");
        (raw as Record<string, unknown>)["role"] = role;
        (raw as Record<string, unknown>)["content"] = textContent || JSON.stringify(content).slice(0, 300);
      }

      entries.push(entry);

      if (entry.type === "compaction") {
        const ce = entry as CompactionEntry;
        compactEvents.push({
          entryId: ce.id,
          parentId: ce.parentId ?? "",
          firstKeptEntryId: ce.firstKeptEntryId,
          tokensBefore: ce.tokensBefore ?? 0,
          summaryText: ce.summaryText ?? ce.content ?? "",
          timestamp: ce.timestamp ? tsToSec(ce.timestamp as string) : undefined,
          lineIndex,
        });
      }
      lineIndex++;
    } catch {
      // skip malformed lines
    }
  }

  return { entries, compactEvents };
}

export function resetCursor(filePath: string): void {
  fileCursors.delete(filePath);
}

// --- Session stats from jsonl ---

/**
 * Parse all entries in a .jsonl file and compute session-level statistics
 * directly from the message usage fields (the authoritative data source).
 */
export function parseSessionStats(filePath: string): SessionStats | null {
  if (!fs.existsSync(filePath)) return null;

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  const lines = raw.split("\n").filter((l) => l.trim().length > 0);

  let sessionId = "";
  let startedAt = 0;
  let lastActiveAt = 0;
  let model: string | null = null;
  let provider: string | null = null;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let lastTotalTokens = 0;
  let userTurns = 0;
  let assistantTurns = 0;
  let errorTurns = 0;
  let toolCallCount = 0;
  let compactionCount = 0;
  const turns: TurnStats[] = [];

  for (const line of lines) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = entry["type"] as string | undefined;
    const ts = entry["timestamp"] as string | number | undefined;
    const entrySec = ts ? tsToSec(String(ts)) : 0;

    if (entrySec > 0) {
      if (startedAt === 0) startedAt = entrySec;
      if (entrySec > lastActiveAt) lastActiveAt = entrySec;
    }

    if (type === "session") {
      sessionId = (entry["id"] as string | undefined) ?? "";
      continue;
    }

    if (type === "compaction") {
      compactionCount++;
      continue;
    }

    if (type !== "message") continue;

    const msg = entry["message"] as Record<string, unknown> | undefined;
    if (!msg) continue;

    const role = msg["role"] as string | undefined;

    // Track model/provider from the most recent assistant message
    if (msg["model"]) model = msg["model"] as string;
    if (msg["provider"]) provider = msg["provider"] as string;

    if (role === "user") {
      userTurns++;
      continue;
    }

    // toolResult entries — skip for token counting
    if (role === "toolResult" || role === "tool") continue;

    if (role === "assistant") {
      const usage = msg["usage"] as TokenUsage | undefined;
      const stopReason = (msg["stopReason"] as string | undefined) ?? "";
      const isError = stopReason === "error" || !!(msg["errorMessage"]);

      // Count tool calls in content
      const content = msg["content"] as unknown[] | undefined ?? [];
      const toolCalls = content.filter(
        (c) => (c as Record<string, unknown>)["type"] === "toolCall"
      ).length;

      if (isError) {
        errorTurns++;
      } else {
        assistantTurns++;
        if (usage) {
          // Both input and output are billed each turn by the API provider.
          // usage.input = full context size sent that turn (not incremental).
          // usage.output = tokens generated that turn (incremental).
          totalInput += usage.input ?? 0;
          totalOutput += usage.output ?? 0;
          totalCacheRead += usage.cacheRead ?? 0;
          // Track the last turn's totalTokens for context window display
          if (usage.totalTokens > 0) {
            lastTotalTokens = usage.totalTokens;
          }
        }
        toolCallCount += toolCalls;

        const msgTs = (msg["timestamp"] as number | undefined);
        const turnTs = msgTs ? Math.floor(msgTs / 1000) : entrySec;

        turns.push({
          turnIndex: assistantTurns,
          timestamp: turnTs,
          model: (msg["model"] as string | undefined) ?? model,
          provider: (msg["provider"] as string | undefined) ?? provider,
          usage: usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
          stopReason,
          isError: false,
          toolCallCount: toolCalls,
        });
      }
    }
  }

  return {
    sessionId,
    startedAt,
    lastActiveAt,
    model,
    provider,
    totalInput,
    totalOutput,
    totalCacheRead,
    lastTotalTokens,
    userTurns,
    assistantTurns,
    errorTurns,
    toolCallCount,
    compactionCount,
    turns,
  };
}

// --- Full analysis helpers ---

export function getCompactedMessages(
  allEntries: JournalEntry[],
  compactEvent: CompactEvent,
  previousFirstKeptId?: string
): MessageEntry[] {
  const messages = allEntries.filter(
    (e): e is MessageEntry => e.type === "message" && (e as MessageEntry).message?.role === "user"
  );

  let started = previousFirstKeptId === undefined;
  const result: MessageEntry[] = [];

  for (const msg of messages) {
    if (!started) {
      if (msg.id === previousFirstKeptId) started = true;
      continue;
    }
    if (msg.id === compactEvent.firstKeptEntryId) break;
    result.push(msg);
  }

  return result;
}

export function buildConversationTree(entries: JournalEntry[]): MessageEntry[] {
  return entries.filter((e): e is MessageEntry => e.type === "message");
}

// --- Helpers ---

function tsToSec(ts: string | number): number {
  if (typeof ts === "number") {
    // milliseconds if > 1e10, else seconds
    return ts > 1e10 ? Math.floor(ts / 1000) : ts;
  }
  const d = new Date(ts);
  return isNaN(d.getTime()) ? 0 : Math.floor(d.getTime() / 1000);
}
