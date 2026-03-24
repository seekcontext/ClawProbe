import fs from "fs";
import path from "path";
import { parseIncremental, resetCursor } from "./jsonl-parser.js";
import type { JournalEntry, MessageEntry, TokenUsage } from "./jsonl-parser.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type LiveEventKind =
  | "session_start"
  | "session_meta"
  | "turn_start"
  | "thinking"
  | "tool_call"
  | "tool_result"
  | "turn_end"
  | "compaction"
  | "subagent_start";

/** Speculative phase after user message, before JSONL assistant row (honest vs Claude-style UX). */
export type LivePendingKind = "awaiting" | "reasoning_pending";

export interface LiveEvent {
  kind: LiveEventKind;
  /** Unix milliseconds */
  timestamp: number;
  /** Tool name (tool_call / tool_result / subagent_start) */
  tool?: string;
  /** OpenClaw / Claude tool call id (pair call ↔ result) */
  toolCallId?: string;
  /** Human-readable summary of tool input */
  toolSummary?: string;
  /** Whether the tool result was an error (tool_result) */
  toolError?: boolean;
  /** Turn counter since stream started */
  turnIndex?: number;
  /** One-line user text after stripping channel metadata (turn_start) */
  userPreview?: string;
  /** Output tokens (turn_end) */
  tokensOut?: number;
  /** Model name (tool_call / turn_end) */
  model?: string;
  /** API stop reason when present (turn_end) */
  stopReason?: string;
  /** Actual thinking content snippet (thinking event, when available from JSONL) */
  thinkingContent?: string;
  /** Synthetic “waiting” line after turn_start — never labeled “thinking” when reasoning is off */
  pendingKind?: LivePendingKind;
  /** session_meta: thinking level from JSONL */
  thinkingLevel?: string;
  /** session_meta: provider id */
  provider?: string;
  /** Tool result: wall time from OpenClaw details */
  durationMs?: number;
  /** Tool result: process exit code when present */
  exitCode?: number | null;
  /** Tool result: truncated stdout-style preview (verbose mode) */
  resultPreview?: string;
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

function getEntryTimestampMs(entry: JournalEntry): number {
  const raw = entry as Record<string, unknown>;
  const ts = raw["timestamp"];
  if (typeof ts === "number") {
    return ts > 1e12 ? ts : ts * 1000;
  }
  if (typeof ts === "string") {
    const d = new Date(ts);
    return isNaN(d.getTime()) ? Date.now() : d.getTime();
  }
  const msg = raw["message"] as Record<string, unknown> | undefined;
  if (msg) {
    const msgTs = msg["timestamp"];
    if (typeof msgTs === "number") {
      return msgTs > 1e12 ? msgTs : msgTs * 1000;
    }
  }
  return Date.now();
}

// ── Entry → LiveEvent(s) conversion ──────────────────────────────────────────

export interface LiveParseCtx {
  turnCounter: number;
  /** Latest effective thinking level from JSONL (`unknown` until first `thinking_level_change`) */
  thinkingLevel: string;
  /** e.g. moonshot/kimi-k2.5 */
  modelLabel: string | null;
  provider: string | null;
}

export function createLiveParseCtx(): LiveParseCtx {
  return {
    turnCounter: 0,
    thinkingLevel: "unknown",
    modelLabel: null,
    provider: null,
  };
}

/** True when the session may emit reasoning blocks (not “off”). */
export function isReasoningLevelEnabled(level: string): boolean {
  return level !== "off" && level !== "unknown";
}

/**
 * Apply OpenClaw journal rows that affect session display (before message parsing).
 * Mutates ctx; returns a session_meta event when something changed.
 */
export function applyJournalMeta(
  entry: JournalEntry,
  ctx: LiveParseCtx
): LiveEvent | null {
  const ts = getEntryTimestampMs(entry);

  if (entry.type === "thinking_level_change") {
    const raw = entry as Record<string, unknown>;
    const tl = raw["thinkingLevel"];
    if (typeof tl !== "string") return null;
    if (tl === ctx.thinkingLevel) return null;
    ctx.thinkingLevel = tl;
    return {
      kind: "session_meta",
      timestamp: ts,
      thinkingLevel: tl,
      model: ctx.modelLabel ?? undefined,
    };
  }

  if (entry.type === "model_change") {
    const raw = entry as Record<string, unknown>;
    const p = raw["provider"];
    const m = raw["modelId"];
    if (typeof p !== "string" || typeof m !== "string") return null;
    const label = `${p}/${m}`;
    if (label === ctx.modelLabel && p === ctx.provider) return null;
    ctx.modelLabel = label;
    ctx.provider = p;
    return {
      kind: "session_meta",
      timestamp: ts,
      model: label,
      provider: p,
      thinkingLevel: ctx.thinkingLevel,
    };
  }

  return null;
}

/**
 * Strip Feishu/Telegram-style wrappers; return a one-line preview for the turn header.
 */
export function extractUserPreview(content: unknown[]): string | undefined {
  const texts: string[] = [];
  for (const block of content) {
    const b = block as Record<string, unknown>;
    if (b["type"] === "text" && typeof b["text"] === "string") {
      texts.push(b["text"]);
    }
  }
  let s = texts.join("\n").trim();
  const tagged = s.match(/\[message_id:[^\]]+]\s*\n?([\s\S]*)$/);
  if (tagged?.[1]) s = tagged[1]!.trim();
  s = s.replace(/\s+/g, " ").trim();
  if (!s) return undefined;
  return s.length > 120 ? s.slice(0, 119) + "…" : s;
}

function summarizeToolResultContent(content: unknown[], maxLen = 72): string | undefined {
  for (const block of content) {
    const b = block as Record<string, unknown>;
    if (b["type"] !== "text") continue;
    const t = b["text"];
    if (typeof t !== "string") continue;
    const line = t.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
    if (!line) continue;
    const one = line.replace(/\s+/g, " ").trim();
    return one.length > maxLen ? one.slice(0, maxLen - 1) + "…" : one;
  }
  return undefined;
}

/**
 * Extract the first meaningful line of thinking content from an assistant
 * message's content array (blocks with type="thinking").
 * Returns undefined if no thinking blocks are present.
 */
function extractThinkingSnippet(content: unknown[]): string | undefined {
  for (const block of content) {
    const b = block as Record<string, unknown>;
    if (b["type"] !== "thinking") continue;
    const raw = b["thinking"];
    if (typeof raw !== "string" || !raw.trim()) continue;

    // Take the first non-empty line as the snippet
    const firstLine = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    if (!firstLine) continue;

    // Truncate at 120 chars
    return firstLine.length > 120 ? firstLine.slice(0, 119) + "…" : firstLine;
  }
  return undefined;
}

export function entryToLiveEvents(
  entry: JournalEntry,
  ctx: LiveParseCtx
): LiveEvent[] {
  const ts = getEntryTimestampMs(entry);

  if (entry.type === "session") {
    ctx.turnCounter = 0;
    ctx.thinkingLevel = "unknown";
    ctx.modelLabel = null;
    ctx.provider = null;
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
    const ucontent = (msg["content"] as unknown[]) ?? [];
    const userPreview = extractUserPreview(ucontent);
    return [
      {
        kind: "turn_start",
        timestamp: ts,
        turnIndex: ctx.turnCounter,
        userPreview,
      },
    ];
  }

  // ── Assistant message ─────────────────────────────────────────────────────
  if (role === "assistant") {
    // Skip delivery-mirror entries (OpenClaw internal)
    const provider = msg["provider"] as string | undefined;
    const model = msg["model"] as string | undefined;
    if (provider === "openclaw" || model === "delivery-mirror") return [];

    const content = (msg["content"] as unknown[]) ?? [];

    // Extract thinking snippet from thinking blocks (written to JSONL after model finishes)
    const thinkingContent = extractThinkingSnippet(content);

    const toolCallBlocks = content.filter(
      (b) => (b as Record<string, unknown>)["type"] === "toolCall"
    );

    const events: LiveEvent[] = [];

    // Emit thinking content if available (prepend before tool calls / turn_end)
    if (thinkingContent) {
      events.push({ kind: "thinking", timestamp: ts, thinkingContent });
    }

    if (toolCallBlocks.length > 0) {
      for (const b of toolCallBlocks) {
        const block = b as Record<string, unknown>;
        const toolName = (block["name"] as string) ?? "unknown";
        const toolCallId =
          typeof block["id"] === "string" ? block["id"] : undefined;
        // OpenClaw JSONL stores tool args as "arguments"; Claude/Cursor style uses "input".
        const toolInput = ((block["arguments"] ?? block["input"]) as Record<string, unknown>) ?? {};
        const isSubagent = toolName === "Task" || toolName === "sessions_spawn";
        events.push({
          kind: isSubagent ? "subagent_start" : "tool_call",
          timestamp: ts,
          tool: toolName,
          toolCallId,
          toolSummary: summarizeToolInput(toolName, toolInput),
          model,
        } satisfies LiveEvent);
      }
      return events;
    }

    // No tool calls → final text reply
    const usage = msg["usage"] as TokenUsage | undefined;
    const stopReason =
      typeof msg["stopReason"] === "string" ? msg["stopReason"] : undefined;
    events.push({
      kind: "turn_end",
      timestamp: ts,
      tokensOut: usage?.output,
      model,
      stopReason,
    });
    return events;
  }

  // ── Tool result ───────────────────────────────────────────────────────────
  if (role === "toolResult" || role === "tool") {
    const content = (msg["content"] as unknown[]) ?? [];
    const topIsError = msg["isError"] === true;
    const blockError = content.some(
      (b) =>
        !!(b as Record<string, unknown>)["isError"] ||
        !!(b as Record<string, unknown>)["is_error"]
    );
    const toolCallId =
      typeof msg["toolCallId"] === "string" ? msg["toolCallId"] : undefined;
    const toolName =
      typeof msg["toolName"] === "string" ? msg["toolName"] : undefined;
    const details = msg["details"] as Record<string, unknown> | undefined;
    let durationMs: number | undefined;
    let exitCode: number | null | undefined;
    if (details && typeof details === "object") {
      if (typeof details["durationMs"] === "number") {
        durationMs = details["durationMs"];
      }
      if (typeof details["exitCode"] === "number") {
        exitCode = details["exitCode"];
      } else if ("exitCode" in details && details["exitCode"] == null) {
        exitCode = null;
      }
    }
    const resultPreview = summarizeToolResultContent(content);
    return [
      {
        kind: "tool_result",
        timestamp: ts,
        tool: toolName,
        toolCallId,
        toolError: topIsError || blockError,
        durationMs,
        exitCode,
        resultPreview,
      },
    ];
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

  const ctx = createLiveParseCtx();
  let pendingThinking = false;

  while (!signal.aborted) {
    try {
      if (!fs.existsSync(filePath)) {
        await sleep(500);
        continue;
      }

      const { entries } = parseIncremental(filePath);

      for (const entry of entries) {
        const meta = applyJournalMeta(entry, ctx);
        if (meta) onEvent(meta);

        const events = entryToLiveEvents(entry, ctx);

        for (const event of events) {
          if (pendingThinking) {
            if (event.kind !== "thinking" || event.thinkingContent) {
              pendingThinking = false;
            }
          }

          if (event.kind === "turn_start") {
            pendingThinking = true;
            onEvent(event);
            const pendingKind: LivePendingKind = isReasoningLevelEnabled(
              ctx.thinkingLevel
            )
              ? "reasoning_pending"
              : "awaiting";
            onEvent({
              kind: "thinking",
              timestamp: event.timestamp,
              pendingKind,
            });
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
