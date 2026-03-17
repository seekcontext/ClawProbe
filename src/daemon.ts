import fs from "fs";
import path from "path";
import { ResolvedConfig } from "./core/config.js";
import { openDb, insertSessionSnapshot } from "./core/db.js";
import { FileWatcher, buildWatchGlobs, FileChange } from "./core/watcher.js";
import { readSessionsStore, listJsonlFiles, sessionKeyFromPath } from "./core/session-store.js";
import { parseIncremental, parseAll } from "./core/jsonl-parser.js";
import { analyzeCompaction } from "./engines/compact-diff.js";
import { snapshotWorkspaceFiles } from "./engines/file-analyzer.js";
import { runRules, persistSuggestions, ProbeState } from "./engines/rule-engine.js";
import { recordDailyCost, todayString } from "./engines/cost.js";
import { upsertCompactEvent } from "./core/db.js";

let watcher: FileWatcher | null = null;

/** Redirect stdout/stderr to daemon.log when running as detached child (stdio is ignored). */
function redirectStdioToLogFile(probeDir: string): void {
  const logPath = path.join(probeDir, "daemon.log");
  const stream = fs.createWriteStream(logPath, { flags: "a" });
  const write = (chunk: unknown, encoding?: unknown, callback?: unknown): boolean => {
    const cb = typeof encoding === "function" ? encoding : typeof callback === "function" ? callback : undefined;
    const enc = (typeof encoding === "string" ? encoding : "utf8") as BufferEncoding;
    if (cb !== undefined) {
      stream.write(String(chunk), enc, cb as (err: Error | null | undefined) => void);
    } else {
      stream.write(String(chunk), enc);
    }
    return true;
  };
  (process.stdout as NodeJS.WritableStream).write = write;
  (process.stderr as NodeJS.WritableStream).write = write;
}

export async function startDaemon(cfg: ResolvedConfig): Promise<void> {
  if (process.env.CLAWPROBE_DAEMON === "1") {
    redirectStdioToLogFile(cfg.probeDir);
  }

  const db = openDb(cfg.probeDir);
  const agent = cfg.probe.openclaw.agent;

  console.log(`✓ clawprobe daemon started  [${new Date().toISOString()}]`);
  console.log(`  openclawDir: ${cfg.openclawDir}`);
  console.log(`  sessionsDir: ${cfg.sessionsDir}`);
  console.log(`  probeDir:    ${cfg.probeDir}`);
  console.log(`  agent:       ${agent}`);

  // Verify sessionsDir exists
  if (!fs.existsSync(cfg.sessionsDir)) {
    console.error(`[daemon] WARNING: sessionsDir does not exist: ${cfg.sessionsDir}`);
    console.error(`[daemon] Token snapshots will not be written until this directory is created.`);
  }

  // Initial scan of all existing .jsonl files
  const jsonlFiles = listJsonlFiles(cfg.sessionsDir);
  console.log(`[daemon] Found ${jsonlFiles.length} .jsonl transcript(s) to scan`);
  for (const jsonlPath of jsonlFiles) {
    try {
      await processJsonlFile(cfg, agent, jsonlPath, true);
    } catch (err) {
      console.error(`[daemon] Error scanning ${jsonlPath}:`, err);
    }
  }

  // Initial snapshot of sessions.json
  try {
    const sessionCount = await processSessionsJson(cfg, agent);
    console.log(`[daemon] Snapshotted ${sessionCount} session(s) from sessions.json`);
  } catch (err) {
    console.error(`[daemon] Error reading sessions.json:`, err);
  }

  // Initial workspace snapshot
  snapshotWorkspaceFiles(db, agent, cfg.workspaceDir, cfg.bootstrapMaxChars);

  // Initial rule run
  runAndPersistRules(cfg, agent);

  const globs = buildWatchGlobs(
    cfg.openclawDir,
    cfg.workspaceDir,
    cfg.sessionsDir
  );

  watcher = new FileWatcher(300).watch(globs);

  watcher.on(async (change: FileChange) => {
    try {
      switch (change.category) {
        case "sessions_json":
          console.log(`[daemon] sessions.json changed, re-reading...`);
          await processSessionsJson(cfg, agent);
          runAndPersistRules(cfg, agent);
          break;

        case "jsonl":
          console.log(`[daemon] .jsonl changed: ${change.filePath}`);
          await processJsonlFile(cfg, agent, change.filePath, false);
          runAndPersistRules(cfg, agent);
          break;

        case "workspace_md":
          snapshotWorkspaceFiles(db, agent, cfg.workspaceDir, cfg.bootstrapMaxChars);
          runAndPersistRules(cfg, agent);
          break;

        case "openclaw_config":
          // Config changed — re-read handled by next command invocation
          break;
      }
    } catch (err) {
      // Log but don't crash the daemon
      console.error("[daemon] Error processing change:", err);
    }
  });

  // Periodic rule re-evaluation (every 5 min)
  const ruleTimer = setInterval(() => {
    runAndPersistRules(cfg, agent);
  }, 5 * 60 * 1000);

  // Graceful shutdown
  const shutdown = async () => {
    clearInterval(ruleTimer);
    if (watcher) await watcher.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

async function processSessionsJson(
  cfg: ResolvedConfig,
  agent: string
): Promise<number> {
  const db = openDb(cfg.probeDir);
  const sessions = readSessionsStore(cfg.sessionsDir);
  const now = Math.floor(Date.now() / 1000);
  const today = todayString();

  for (const session of sessions) {
    insertSessionSnapshot(db, {
      agent,
      session_key: session.sessionKey,
      session_id: session.sessionId,
      model: session.modelOverride ?? null,
      provider: session.providerOverride ?? null,
      input_tokens: session.inputTokens,
      output_tokens: session.outputTokens,
      total_tokens: session.totalTokens,
      context_tokens: session.contextTokens,
      compaction_count: session.compactionCount,
      sampled_at: now,
    });

    // Record incremental cost
    const { getAllSnapshots } = await import("./core/db.js");
    const snaps = getAllSnapshots(db, agent, session.sessionKey);
    if (snaps.length >= 2) {
      const prev = snaps[snaps.length - 2]!;
      const curr = snaps[snaps.length - 1]!;
      const inDelta = Math.max(0, curr.input_tokens - prev.input_tokens);
      const outDelta = Math.max(0, curr.output_tokens - prev.output_tokens);
      if (inDelta > 0 || outDelta > 0) {
        recordDailyCost(
          db,
          agent,
          session.sessionKey,
          today,
          inDelta,
          outDelta,
          curr.model,
          cfg.probe.cost.customPrices
        );
      }
    }
  }

  return sessions.length;
}

async function processJsonlFile(
  cfg: ResolvedConfig,
  agent: string,
  filePath: string,
  fullScan: boolean
): Promise<void> {
  const db = openDb(cfg.probeDir);
  const sessionKey = sessionKeyFromPath(filePath);

  const { entries, compactEvents } =
    fullScan ? parseAll(filePath) : parseIncremental(filePath);

  if (compactEvents.length === 0) return;

  let prevFirstKeptId: string | undefined;

  for (const event of compactEvents) {
    const compactedMessages = (await import("./core/jsonl-parser.js"))
      .getCompactedMessages(entries, event, prevFirstKeptId);

    const analysis = analyzeCompaction(event, entries, prevFirstKeptId);

    upsertCompactEvent(db, {
      agent,
      session_key: sessionKey,
      compaction_entry_id: event.entryId,
      first_kept_entry_id: event.firstKeptEntryId,
      tokens_before: event.tokensBefore ?? null,
      summary_text: event.summaryText,
      compacted_at: event.timestamp ?? null,
      compacted_message_count: compactedMessages.length,
      compacted_messages: JSON.stringify(
        compactedMessages.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content.slice(0, 2000),
        }))
      ),
    });

    prevFirstKeptId = event.firstKeptEntryId;
  }
}

function runAndPersistRules(cfg: ResolvedConfig, agent: string): void {
  const db = openDb(cfg.probeDir);
  const state: ProbeState = {
    db,
    agent,
    workspaceDir: cfg.workspaceDir,
    sessionsDir: cfg.sessionsDir,
    bootstrapMaxChars: cfg.bootstrapMaxChars,
    config: cfg.probe,
  };

  try {
    const suggestions = runRules(state);
    persistSuggestions(db, agent, suggestions);
  } catch {
    // swallow rule errors
  }
}
