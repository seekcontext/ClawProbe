import fs from "fs";
import path from "path";
import { ResolvedConfig } from "../../core/config.js";
import { openDb } from "../../core/db.js";
import { getActiveSession, readSessionsStore } from "../../core/session-store.js";
import { getLatestSnapshot } from "../../core/db.js";
import { parseAll } from "../../core/jsonl-parser.js";
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

  // sessionTokens = actual tokens currently in the model's context window
  // (matches "Session tokens (cached): N total" in /context detail)
  // windowSize = context window upper limit (ctx=256000)
  // sessions.json's contextTokens field stores the window upper limit, NOT actual usage.
  const sessionTokens = sessionEntry.sessionTokens;   // actual usage; 0 if not reported
  const windowSize = sessionEntry.windowSize || sessionEntry.contextTokens; // upper limit

  let compactionCount = sessionEntry.compactionCount;
  let lastActiveAt = sessionEntry.updatedAt;

  // When sessions.json has no token/compact data yet, derive from transcript.
  const transcriptPath = path.join(cfg.sessionsDir, `${sessionEntry.sessionKey}.jsonl`);
  if (fs.existsSync(transcriptPath)) {
    if (compactionCount === 0) {
      try {
        const { compactEvents } = parseAll(transcriptPath);
        compactionCount = compactEvents.length;
      } catch {
        // ignore parse errors
      }
    }
    if (lastActiveAt === 0) {
      try {
        lastActiveAt = Math.floor(fs.statSync(transcriptPath).mtimeMs / 1000);
      } catch {
        // ignore
      }
    }
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
