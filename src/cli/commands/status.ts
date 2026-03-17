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

  // Prefer live sessions.json (and snapshot only for model/context when present)
  let contextTokens = snapshot?.context_tokens ?? sessionEntry.contextTokens;
  let compactionCount = sessionEntry.compactionCount;
  let lastActiveAt = sessionEntry.updatedAt;

  // When sessions.json has no token/compact data yet, derive from transcript so
  // "clawprobe status" shows existing state without requiring daemon to have run first.
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
  const windowSize = getWindowSize(model, contextTokens);
  const utilization = contextTokens / windowSize;
  const isActive = !opts.session;

  if (opts.json) {
    outputJson({
      agent,
      sessionKey: sessionEntry.sessionKey,
      sessionId: sessionEntry.sessionId,
      model,
      provider: snapshot?.provider ?? sessionEntry.providerOverride ?? null,
      contextTokens,
      windowSize,
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
  console.log(
    `  Context:   ${fmtTokens(contextTokens)} / ${fmtTokens(windowSize)} tokens  ` +
    `${tokenBar(contextTokens, windowSize)}  ${Math.round(utilization * 100)}%`
  );
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
    sessionEntry.contextTokens === 0 &&
    fs.existsSync(transcriptPath)
  ) {
    console.log();
    console.log(
      severity.muted("  Token counts come from sessions.json. If OpenClaw hasn’t written them yet, run a turn or check your OpenClaw version.")
    );
  }

  console.log();
}
