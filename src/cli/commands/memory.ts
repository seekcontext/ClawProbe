import path from "path";
import { ResolvedConfig } from "../../core/config.js";
import { openDb, getCompactEventById } from "../../core/db.js";
import {
  listEntries,
  addEntry,
  updateEntry,
  deleteEntry,
  saveCompactedMessages,
  searchAllMemoryFiles,
  collectMemoryFiles,
} from "../../core/memory-editor.js";
import { MessageEntry } from "../../core/jsonl-parser.js";
import {
  header, outputJson, severity, printSuccess, printError, fmtDate,
} from "../format.js";

interface MemoryListOptions {
  agent?: string;
  file?: string;
  json?: boolean;
}

interface MemorySearchOptions {
  agent?: string;
  limit?: number;
  json?: boolean;
}

interface MemoryAddOptions {
  agent?: string;
  file?: string;
}

interface MemoryEditOptions {
  agent?: string;
  file?: string;
}

interface MemoryDeleteOptions {
  agent?: string;
  file?: string;
  yes?: boolean;
}

interface MemorySaveCompactOptions {
  agent?: string;
  file?: string;
}

function resolveMemoryFile(cfg: ResolvedConfig, fileOpt?: string): string {
  if (fileOpt) return path.isAbsolute(fileOpt) ? fileOpt : path.join(cfg.workspaceDir, fileOpt);
  return path.join(cfg.workspaceDir, cfg.probe.memory.defaultFile);
}

export async function runMemoryList(cfg: ResolvedConfig, opts: MemoryListOptions): Promise<void> {
  const memFile = resolveMemoryFile(cfg, opts.file);
  const entries = listEntries(memFile);
  const relFile = path.relative(cfg.workspaceDir, memFile);

  if (opts.json) {
    outputJson({ file: relFile, entries });
    return;
  }

  header("🧠", "Long-term Memory", relFile);

  if (entries.length === 0) {
    console.log(severity.muted("  No entries found."));
    console.log();
    return;
  }

  for (const entry of entries) {
    console.log(`  ${severity.muted(String(entry.index).padStart(3))}   ${entry.content}`);
  }

  console.log();
  console.log(severity.muted(`  ${entries.length} entries`));
  console.log();
}

export async function runMemorySearch(
  cfg: ResolvedConfig,
  query: string,
  opts: MemorySearchOptions
): Promise<void> {
  const limit = opts.limit ?? 10;
  const allResults = searchAllMemoryFiles(cfg.workspaceDir, query);
  const results = allResults.slice(0, limit);

  if (opts.json) {
    outputJson(results.map((r) => ({
      file: path.relative(cfg.workspaceDir, r.file),
      entryIndex: r.entry.index,
      content: r.entry.content,
    })));
    return;
  }

  header("🔍", `Search: "${query}"`);

  if (results.length === 0) {
    console.log(severity.muted(`  No results found for "${query}"`));
    console.log();
    return;
  }

  for (const [i, result] of results.entries()) {
    const relFile = path.relative(cfg.workspaceDir, result.file);
    console.log(`  ${i + 1}.  ${severity.muted(relFile + ":" + result.entry.index)}`);
    console.log(`       ${result.entry.content}`);
    console.log();
  }
}

export async function runMemoryAdd(
  cfg: ResolvedConfig,
  content: string,
  opts: MemoryAddOptions
): Promise<void> {
  const memFile = resolveMemoryFile(cfg, opts.file);
  const relFile = path.relative(cfg.workspaceDir, memFile);

  addEntry(memFile, content);

  const entries = listEntries(memFile);
  printSuccess(`Added to ${relFile} (entry #${entries.length})`);
}

export async function runMemoryEdit(
  cfg: ResolvedConfig,
  entryIndex: number,
  newContent: string | undefined,
  opts: MemoryEditOptions
): Promise<void> {
  const memFile = resolveMemoryFile(cfg, opts.file);
  const relFile = path.relative(cfg.workspaceDir, memFile);

  const entries = listEntries(memFile);
  const entry = entries.find((e) => e.index === entryIndex);

  if (!entry) {
    printError(`Entry #${entryIndex} not found in ${relFile}`);
    process.exit(1);
  }

  let content = newContent;
  if (!content) {
    // Open $EDITOR
    const editor = process.env["EDITOR"] ?? "vi";
    const { execSync } = await import("child_process");
    const tmpFile = `/tmp/clawprobe_edit_${Date.now()}.txt`;
    const { writeFileSync, readFileSync, unlinkSync } = await import("fs");
    writeFileSync(tmpFile, entry.content, "utf-8");
    try {
      execSync(`${editor} ${tmpFile}`, { stdio: "inherit" });
      content = readFileSync(tmpFile, "utf-8").trim();
    } finally {
      unlinkSync(tmpFile);
    }
  }

  updateEntry(memFile, entryIndex, content);
  printSuccess(`Updated entry #${entryIndex} in ${relFile}`);
}

export async function runMemoryDelete(
  cfg: ResolvedConfig,
  entryIndex: number,
  opts: MemoryDeleteOptions
): Promise<void> {
  const memFile = resolveMemoryFile(cfg, opts.file);
  const relFile = path.relative(cfg.workspaceDir, memFile);

  const entries = listEntries(memFile);
  const entry = entries.find((e) => e.index === entryIndex);

  if (!entry) {
    printError(`Entry #${entryIndex} not found in ${relFile}`);
    process.exit(1);
  }

  if (!opts.yes) {
    console.log(`\n  ${severity.warning("About to delete entry")} #${entryIndex}:`);
    console.log(`    "${entry.content}"`);

    const { createInterface } = await import("readline");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const confirmed = await new Promise<boolean>((resolve) => {
      rl.question("\n  Confirm? [y/N]: ", (ans) => {
        rl.close();
        resolve(ans.toLowerCase() === "y");
      });
    });

    if (!confirmed) {
      console.log(severity.muted("  Cancelled."));
      return;
    }
  }

  deleteEntry(memFile, entryIndex);
  printSuccess(`Deleted entry #${entryIndex} from ${relFile}`);
}

export async function runMemorySaveCompact(
  cfg: ResolvedConfig,
  compactId: number,
  opts: MemorySaveCompactOptions
): Promise<void> {
  const db = openDb(cfg.probeDir);
  const event = getCompactEventById(db, compactId);

  if (!event) {
    printError(`Compact event #${compactId} not found.`);
    process.exit(1);
  }

  const messages: MessageEntry[] = event.compacted_messages
    ? JSON.parse(event.compacted_messages)
    : [];

  if (messages.length === 0) {
    console.log(severity.muted("  No messages to save for this compact event."));
    return;
  }

  const memFile = resolveMemoryFile(cfg, opts.file);
  const relFile = path.relative(cfg.workspaceDir, memFile);
  const label = event.compacted_at ? fmtDate(event.compacted_at) : `compact-${compactId}`;

  saveCompactedMessages(memFile, messages, label);
  printSuccess(`Saved ${messages.length} messages from compact #${compactId} to ${relFile}`);
}
