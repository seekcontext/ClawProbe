import fs from "fs";
import path from "path";
import { parseIncremental, resetCursor } from "./jsonl-parser.js";
import type { JournalEntry, MessageEntry, TokenUsage } from "./jsonl-parser.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type LiveEventKind =
  | "session_start"
  | "turn_start"
  | "thinking"
  | "tool_call"
  | "tool_result"
  | "turn_end"
  | "compaction"
  | "subagent_start";

export interface LiveEvent {
  kind: LiveEventKind;
  /** Unix milliseconds */
  timestamp: number;
  /** Tool name (tool_call / subagent_start) */
  tool?: string;
  /** Human-readable summary of tool input */
  toolSummary?: string;
  /** Whether the tool result was an error (tool_result) */
  toolError?: boolean;
  /** Turn counter since stream started */
  turnIndex?: number;
  /** Output tokens (turn_end) */
  tokensOut?: number;
  /** Model name (tool_call / turn_end) */
  model?: string;
}

// ── Tool icon map ─────────────────────────────────────────────────────────────

const TOOL_ICONS: Record<string, string> = {
  // OpenClaw native tools (lowercase / snake_case)
  read:            "📖",
  write:           "✏️ ",
  edit:            "✏️ ",
  exec:            "💻",
  glob:            "🔍",
  web_search:      "🌐",
  web_fetch:       "🌐",
  memory_search:   "🧠",
  memory_get:      "🧠",
  message:         "✉️ ",
  sessions_spawn:  "🤖",
  apply_patch:     "🩹",
  // Claude Code / Cursor style tools (TitleCase)
  Read:       "📖",
  ReadFile:   "📖",
  Edit:       "✏️ ",
  Write:      "✏️ ",
  MultiEdit:  "✏️ ",
  Bash:       "💻",
  Shell:      "💻",
  Grep:       "🔍",
  Glob:       "🔍",
  WebSearch:  "🌐",
  WebFetch:   "🌐",
  Browser:    "🌐",
  TodoWrite:  "📋",
  TaskCreate: "📋",
  TaskUpdate: "📋",
};

export function getToolIcon(name: string): string {
  return TOOL_ICONS[name] ?? "🔧";
}

// ── Tool input summarizer ─────────────────────────────────────────────────────

function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

export function summarizeToolInput(
  name: string,
  input: Record<string, unknown>
): string {
  const str = (key: string): string => {
    const v = input[key];
    return typeof v === "string" ? v : "";
  };
  const basename = (p: string) => (p ? path.basename(p) : "");

  switch (name) {
    // ── OpenClaw native tools ──────────────────────────────────────────────
    case "read":
      return basename(str("path") || str("file") || str("file_path"));
    case "write":
    case "edit":
      return basename(str("path") || str("file") || str("file_path"));
    case "exec": {
      const cmd = str("command") || str("cmd");
      return trunc(cmd, 55);
    }
    case "glob":
      return trunc(str("pattern") || str("glob_pattern"), 40);
    case "web_search":
      return trunc(str("query"), 45);
    case "web_fetch":
      return trunc(str("url"), 45);
    case "memory_search":
      return trunc(str("query"), 40);
    case "memory_get":
      return str("path") || "";
    case "message": {
      // message tool is action-based: { action: "send", provider: "feishu", to: "..." }
      const action = str("action");
      const provider = str("provider");
      const to = str("to");
      const parts: string[] = [];
      if (action) parts.push(action);
      if (provider) parts.push(provider);
      if (to) parts.push(trunc(to, 20));
      return parts.join(" → ");
    }
    case "sessions_spawn": {
      // OpenClaw subagent launcher: { label, task, agentId }
      const label = str("label") || str("agentId");
      const task = str("task");
      if (label && task) return `${label}: ${trunc(task, 30)}`;
      if (task) return trunc(task, 40);
      if (label) return label;
      return "";
    }
    case "apply_patch":
      return "";

    // ── Claude Code / Cursor style tools ──────────────────────────────────
    case "Read":
    case "ReadFile":
      return basename(str("path") || str("file_path"));
    case "Edit":
    case "Write":
    case "MultiEdit":
      return basename(str("path") || str("file_path"));
    case "Bash":
    case "Shell":
      return trunc(str("command") || str("cmd"), 55);
    case "Grep":
      return trunc(str("pattern"), 40);
    case "Glob":
      return trunc(str("glob_pattern") || str("pattern"), 40);
    case "WebSearch":
      return trunc(str("query"), 45);
    case "WebFetch":
    case "Browser":
      return trunc(str("url"), 45);
    case "Task":
      return `${str("subagent_type")} — "${trunc(str("description"), 28)}"`;
    case "TodoWrite": {
      const todos = (input["todos"] as unknown[]) ?? [];
      return `${todos.length} item${todos.length !== 1 ? "s" : ""}`;
    }
    default:
      return "";
  }
}

// ── Entry → LiveEvent(s) conversion ──────────────────────────────────────────

interface ParseCtx {
  turnCounter: number;
}

function getEntryTimestampMs(entry: JournalEntry): number {
  const raw = entry as Record<string, unknown>;
  const ts = raw["timestamp"];
  if (typeof ts === "number") {
    // seconds (< 1e12) or milliseconds (>= 1e12)
    return ts > 1e12 ? ts : ts * 1000;
  }
  if (typeof ts === "string") {
    const d = new Date(ts);
    return isNaN(d.getTime()) ? Date.now() : d.getTime();
  }
  // Fallback: check message.timestamp for assistant messages
  const msg = raw["message"] as Record<string, unknown> | undefined;
  if (msg) {
    const msgTs = msg["timestamp"];
    if (typeof msgTs === "number") {
      return msgTs > 1e12 ? msgTs : msgTs * 1000;
    }
  }
  return Date.now();
}

export function entryToLiveEvents(
  entry: JournalEntry,
  ctx: ParseCtx
): LiveEvent[] {
  const ts = getEntryTimestampMs(entry);

  if (entry.type === "session") {
    ctx.turnCounter = 0;
    return [{ kind: "session_start", timestamp: ts }];
  }

  if (entry.type === "compaction") {
    return [{ kind: "compaction", timestamp: ts }];
  }

  if (entry.type !== "message") return [];

  const msgEntry = entry as MessageEntry;
  const msg = msgEntry.message as Record<string, unknown> | undefined;
  if (!msg) return [];

  const role = msg["role"] as string | undefined;

  // ── User message → turn_start ─────────────────────────────────────────────
  if (role === "user") {
    ctx.turnCounter++;
    return [{ kind: "turn_start", timestamp: ts, turnIndex: ctx.turnCounter }];
  }

  // ── Assistant message ─────────────────────────────────────────────────────
  if (role === "assistant") {
    // Skip delivery-mirror entries (OpenClaw internal)
    const provider = msg["provider"] as string | undefined;
    const model = msg["model"] as string | undefined;
    if (provider === "openclaw" || model === "delivery-mirror") return [];

    const content = (msg["content"] as unknown[]) ?? [];
    const toolCallBlocks = content.filter(
      (b) => (b as Record<string, unknown>)["type"] === "toolCall"
    );

    if (toolCallBlocks.length > 0) {
      return toolCallBlocks.map((b) => {
        const block = b as Record<string, unknown>;
        const toolName = (block["name"] as string) ?? "unknown";
        // OpenClaw JSONL stores tool args as "arguments"; Claude/Cursor style uses "input".
        // Support both so the same code works across agents.
        const toolInput = ((block["arguments"] ?? block["input"]) as Record<string, unknown>) ?? {};
        // Both Claude-style "Task" and OpenClaw-style "sessions_spawn" launch subagents
        const isSubagent = toolName === "Task" || toolName === "sessions_spawn";
        return {
          kind: isSubagent ? "subagent_start" : "tool_call",
          timestamp: ts,
          tool: toolName,
          toolSummary: summarizeToolInput(toolName, toolInput),
          model,
        } satisfies LiveEvent;
      });
    }

    // No tool calls → final text reply
    const usage = msg["usage"] as TokenUsage | undefined;
    return [{
      kind: "turn_end",
      timestamp: ts,
      tokensOut: usage?.output,
      model,
    }];
  }

  // ── Tool result ───────────────────────────────────────────────────────────
  if (role === "toolResult" || role === "tool") {
    const content = (msg["content"] as unknown[]) ?? [];
    const hasError = content.some(
      (b) => !!(b as Record<string, unknown>)["isError"] ||
             !!(b as Record<string, unknown>)["is_error"]
    );
    return [{ kind: "tool_result", timestamp: ts, toolError: hasError }];
  }

  return [];
}

// ── Main streaming loop ───────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Tail a JSONL file, parsing new entries every 100ms and emitting LiveEvents.
 *
 * skipHistory=true  → starts from the current end of the file (ignores past turns)
 * skipHistory=false → starts from the beginning (replays all turns)
 */
export async function startLiveStream(
  filePath: string,
  onEvent: (event: LiveEvent) => void,
  signal: AbortSignal,
  skipHistory = true
): Promise<void> {
  if (skipHistory) {
    // Fast-forward cursor to the current end — discard existing history
    if (fs.existsSync(filePath)) {
      parseIncremental(filePath);
    }
  } else {
    resetCursor(filePath);
  }

  const ctx: ParseCtx = { turnCounter: 0 };
  let pendingThinking = false;

  while (!signal.aborted) {
    try {
      if (!fs.existsSync(filePath)) {
        await sleep(500);
        continue;
      }

      const { entries } = parseIncremental(filePath);

      for (const entry of entries) {
        const events = entryToLiveEvents(entry, ctx);

        for (const event of events) {
          // Cancel pending "Thinking..." when real content arrives
          if (pendingThinking && event.kind !== "thinking") {
            pendingThinking = false;
          }

          if (event.kind === "turn_start") {
            pendingThinking = true;
            onEvent(event);
            // Show thinking indicator immediately after turn_start
            onEvent({ kind: "thinking", timestamp: event.timestamp });
            continue;
          }

          onEvent(event);
        }
      }
    } catch {
      // File temporarily unavailable — keep polling
    }

    await sleep(100);
  }
}

/**
 * Find the JSONL file most recently written to within the last 5 minutes.
 * Falls back to the most recent file overall.
 */
export function findMostRecentJsonl(sessionsDir: string): string | null {
  if (!fs.existsSync(sessionsDir)) return null;

  const files = fs
    .readdirSync(sessionsDir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const fullPath = path.join(sessionsDir, f);
      try {
        const mtime = fs.statSync(fullPath).mtimeMs;
        return { path: fullPath, mtime };
      } catch {
        return null;
      }
    })
    .filter((f): f is { path: string; mtime: number } => f !== null)
    .sort((a, b) => b.mtime - a.mtime);

  if (files.length === 0) return null;

  // Prefer files modified in the last 5 minutes
  const fiveMinAgo = Date.now() - 5 * 60 * 1000;
  const recent = files.find((f) => f.mtime > fiveMinAgo);
  return (recent ?? files[0]!).path;
}
