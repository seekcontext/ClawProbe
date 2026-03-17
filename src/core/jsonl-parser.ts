import fs from "fs";

// --- Entry Types ---

export interface SessionHeader {
  type: "session";
  id: string;
  cwd: string;
  timestamp: number;
  parentSession?: string;
}

export interface MessageEntry {
  type: "message";
  id: string;
  parentId: string;
  role: "user" | "assistant" | "tool";
  content: string;
  timestamp?: number;
}

export interface CompactionEntry {
  type: "compaction";
  id: string;
  parentId: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  content: string;
  timestamp?: number;
}

export interface CustomMessageEntry {
  type: "custom_message";
  id: string;
  parentId: string;
  role: string;
  content: string;
  hidden?: boolean;
}

export type JournalEntry =
  | SessionHeader
  | MessageEntry
  | CompactionEntry
  | CustomMessageEntry
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
      const entry = JSON.parse(line) as JournalEntry;
      entries.push(entry);

      if (entry.type === "compaction") {
        const ce = entry as CompactionEntry;
        compactEvents.push({
          entryId: ce.id,
          parentId: ce.parentId,
          firstKeptEntryId: ce.firstKeptEntryId,
          tokensBefore: ce.tokensBefore,
          summaryText: ce.content,
          timestamp: ce.timestamp,
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

// --- Full analysis helpers ---

export function getCompactedMessages(
  allEntries: JournalEntry[],
  compactEvent: CompactEvent,
  previousFirstKeptId?: string
): MessageEntry[] {
  const messages = allEntries.filter(
    (e): e is MessageEntry => e.type === "message"
  );

  // Entries after the previous compact boundary, before this compact's firstKeptEntryId
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
  // Return messages in insertion order (they form a linear chain via parentId)
  return entries.filter((e): e is MessageEntry => e.type === "message");
}
