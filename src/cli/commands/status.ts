import fs from "fs";
import path from "path";
import { ResolvedConfig } from "../../core/config.js";
import { openDb } from "../../core/db.js";
import { getActiveSession, readSessionsStore, listJsonlFiles, sessionKeyFromPath } from "../../core/session-store.js";
import { getLatestSnapshot } from "../../core/db.js";
import { parseAll, parseSessionStats } from "../../core/jsonl-parser.js";
import {
  header, fmtTokens, fmtDate, fmtUsd, tokenBar, outputJson, printError, severity,
  getWindowSize,
} from "../format.js";

interface StatusOptions {
  agent?: string;
  session?: string;
  json?: boolean;
}

export async function runStatus(cfg: ResolvedConfig, opts: StatusOptions): Promise<void> {
  const agent = opts.agent ?? cfg.probe.openclaw.agent;
  const db = openDb(cfg.probeDir);

  let sessionEntry = opts.session
    ? readSessionsStore(cfg.sessionsDir).find((s) => s.sessionKey === opts.session)
    : getActiveSession(cfg.sessionsDir);

  if (!sessionEntry) {
    printError("No active session found. Make sure OpenClaw is running.");
    process.exit(1);
  }

  const snapshot = getLatestSnapshot(db, agent, sessionEntry.sessionKey);

  // Prefer jsonl transcript as the authoritative source for actual context token count.
  // Each assistant message reports `usage.totalTokens` = cumulative context at that turn.
  const transcriptPath = path.join(cfg.sessionsDir, `${sessionEntry.sessionKey}.jsonl`);
  const jsonlStats = fs.existsSync(transcriptPath) ? parseSessionStats(transcriptPath) : null;

  // sessionTokens = actual tokens in context right now
  // jsonlStats.lastTotalTokens is the most accurate (from last assistant message's usage.totalTokens)
  const sessionTokens = jsonlStats?.lastTotalTokens ?? sessionEntry.sessionTokens;
  const windowSize = sessionEntry.windowSize || sessionEntry.contextTokens; // upper limit from sessions.json

  // Use jsonl stats for compaction count and last active time (more reliable)
  let compactionCount = jsonlStats?.compactionCount ?? sessionEntry.compactionCount;
  let lastActiveAt = jsonlStats?.lastActiveAt ?? sessionEntry.updatedAt;

  // Final fallback: transcript mtime
  if (lastActiveAt === 0 && fs.existsSync(transcriptPath)) {
    try {
      lastActiveAt = Math.floor(fs.statSync(transcriptPath).mtimeMs / 1000);
    } catch { /* ignore */ }
  }

  const model = snapshot?.model ?? sessionEntry.modelOverride ?? null;
  const resolvedWindowSize = getWindowSize(model, windowSize || sessionTokens);
  const displayContextTokens = sessionTokens > 0 ? sessionTokens : 0;
  const utilization = resolvedWindowSize > 0 ? displayContextTokens / resolvedWindowSize : 0;
  const isActive = !opts.session;

  if (opts.json) {
    outputJson({
      agent,
      sessionKey: sessionEntry.sessionKey,
      sessionId: sessionEntry.sessionId,
      model,
      provider: snapshot?.provider ?? sessionEntry.providerOverride ?? null,
      sessionTokens: displayContextTokens,
      windowSize: resolvedWindowSize,
      utilizationPct: Math.round(utilization * 100),
      inputTokens: sessionEntry.inputTokens,
      outputTokens: sessionEntry.outputTokens,
      compactionCount,
      lastActiveAt,
      isActive,
    });
    return;
  }

  header("📊", "Agent Status", isActive ? "(active session)" : `session: ${sessionEntry.sessionKey}`);

  console.log(`  Agent:     ${severity.bold(agent)}`);
  console.log(`  Session:   ${severity.muted(sessionEntry.sessionKey)}${isActive ? " ●" : ""}`);
  if (model) console.log(`  Model:     ${model}`);

  console.log();
  if (displayContextTokens > 0) {
    console.log(
      `  Context:   ${fmtTokens(displayContextTokens)} / ${fmtTokens(resolvedWindowSize)} tokens  ` +
      `${tokenBar(displayContextTokens, resolvedWindowSize)}  ${Math.round(utilization * 100)}%`
    );
  } else {
    console.log(
      `  Context window: ${fmtTokens(resolvedWindowSize)} tokens  ` +
      severity.muted("(actual usage not in sessions.json — run: clawprobe context)")
    );
  }
  console.log(
    `  This session: ${fmtTokens(sessionEntry.inputTokens)} in / ${fmtTokens(sessionEntry.outputTokens)} out`
  );
  console.log(`  Compacts:  ${compactionCount}`);

  if (lastActiveAt) {
    console.log(`  Last active: ${fmtDate(lastActiveAt)}`);
  }
  if (
    sessionEntry.inputTokens === 0 &&
    sessionEntry.outputTokens === 0 &&
    fs.existsSync(transcriptPath)
  ) {
    console.log();
    console.log(
      severity.muted("  Token counts come from sessions.json. If OpenClaw hasn't written them yet, run a turn or check your OpenClaw version.")
    );
  }

  console.log();
}
