import fs from "fs";
import path from "path";
import { MessageEntry } from "./jsonl-parser.js";

export interface MemoryEntry {
  index: number;      // 1-based
  content: string;
  rawLine: string;
}

const LIST_ITEM_RE = /^(\s*[-*+]|\s*\d+[.)]) (.+)$/;

export function listEntries(memoryFilePath: string): MemoryEntry[] {
  if (!fs.existsSync(memoryFilePath)) return [];

  const lines = fs.readFileSync(memoryFilePath, "utf-8").split("\n");
  const entries: MemoryEntry[] = [];
  let index = 1;

  for (const line of lines) {
    const m = LIST_ITEM_RE.exec(line);
    if (m) {
      entries.push({
        index: index++,
        content: m[2]!.trim(),
        rawLine: line,
      });
    }
  }

  return entries;
}

export function addEntry(memoryFilePath: string, content: string): void {
  ensureFile(memoryFilePath);

  const raw = fs.readFileSync(memoryFilePath, "utf-8");
  const trimmed = raw.trimEnd();
  const separator = trimmed.length > 0 ? "\n" : "";
  fs.writeFileSync(
    memoryFilePath,
    `${trimmed}${separator}\n- ${content.trim()}\n`,
    "utf-8"
  );
}

export function updateEntry(
  memoryFilePath: string,
  entryIndex: number,
  newContent: string
): void {
  const lines = readLines(memoryFilePath);
  let found = 0;

  const updated = lines.map((line) => {
    if (LIST_ITEM_RE.test(line)) {
      found++;
      if (found === entryIndex) {
        return `- ${newContent.trim()}`;
      }
    }
    return line;
  });

  if (found < entryIndex) {
    throw new Error(`Entry #${entryIndex} not found (file has ${found} entries)`);
  }

  fs.writeFileSync(memoryFilePath, updated.join("\n"), "utf-8");
}

export function deleteEntry(
  memoryFilePath: string,
  entryIndex: number
): void {
  const lines = readLines(memoryFilePath);
  let found = 0;
  let deletedLine = -1;

  lines.forEach((line, i) => {
    if (LIST_ITEM_RE.test(line)) {
      found++;
      if (found === entryIndex) deletedLine = i;
    }
  });

  if (deletedLine === -1) {
    throw new Error(`Entry #${entryIndex} not found (file has ${found} entries)`);
  }

  const updated = lines.filter((_, i) => i !== deletedLine);
  fs.writeFileSync(memoryFilePath, updated.join("\n"), "utf-8");
}

export function saveCompactedMessages(
  memoryFilePath: string,
  messages: MessageEntry[],
  label?: string
): void {
  ensureFile(memoryFilePath);

  const raw = fs.readFileSync(memoryFilePath, "utf-8");
  const trimmed = raw.trimEnd();

  const headerLine = label
    ? `\n\n<!-- Saved from compact: ${label} -->`
    : `\n\n<!-- Saved from compact event -->`;

  const lines = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => {
      const prefix = m.role === "user" ? "User" : "Agent";
      const text = m.content.slice(0, 300).replace(/\n/g, " ").trim();
      return `- [${prefix}] ${text}`;
    })
    .join("\n");

  fs.writeFileSync(
    memoryFilePath,
    `${trimmed}${headerLine}\n${lines}\n`,
    "utf-8"
  );
}

export function searchInFile(
  memoryFilePath: string,
  query: string
): MemoryEntry[] {
  const entries = listEntries(memoryFilePath);
  const lq = query.toLowerCase();
  return entries.filter((e) => e.content.toLowerCase().includes(lq));
}

export function searchAllMemoryFiles(
  workspaceDir: string,
  query: string
): { file: string; entry: MemoryEntry }[] {
  const results: { file: string; entry: MemoryEntry }[] = [];

  const candidates = collectMemoryFiles(workspaceDir);
  for (const filePath of candidates) {
    const hits = searchInFile(filePath, query);
    for (const entry of hits) {
      results.push({ file: filePath, entry });
    }
  }

  return results;
}

export function collectMemoryFiles(workspaceDir: string): string[] {
  const files: string[] = [];

  const mainMemory = path.join(workspaceDir, "MEMORY.md");
  if (fs.existsSync(mainMemory)) files.push(mainMemory);

  const dailyDir = path.join(workspaceDir, "memory");
  if (fs.existsSync(dailyDir) && fs.statSync(dailyDir).isDirectory()) {
    const dailyFiles = fs
      .readdirSync(dailyDir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .reverse()
      .map((f) => path.join(dailyDir, f));
    files.push(...dailyFiles);
  }

  return files;
}

function readLines(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf-8").split("\n");
}

function ensureFile(filePath: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, "", "utf-8");
  }
}
