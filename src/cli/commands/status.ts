import { ResolvedConfig } from "../../core/config.js";
import { openDb } from "../../core/db.js";
import { getActiveSession, readSessionsStore } from "../../core/session-store.js";
import { getLatestSnapshot } from "../../core/db.js";
import {
  header, fmtTokens, fmtDate, fmtUsd, tokenBar, outputJson, printError, severity,
} from "../format.js";

interface StatusOptions {
  agent?: string;
  session?: string;
  json?: boolean;
}

const MODEL_WINDOWS: Record<string, number> = {
  "claude-opus-4": 200000,
  "claude-sonnet-4.5": 200000,
  "gpt-5.4": 128000,
  "gpt-5.4-mini": 128000,
  "gemini-3.1-flash": 1000000,
  "deepseek-v3": 128000,
};

function getWindowSize(model: string | null): number {
  if (!model) return 128000;
  const key = Object.keys(MODEL_WINDOWS).find((k) => model.includes(k));
  return key ? MODEL_WINDOWS[key]! : 128000;
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

  const contextTokens = snapshot?.context_tokens ?? sessionEntry.contextTokens;
  const model = snapshot?.model ?? sessionEntry.modelOverride ?? null;
  const windowSize = getWindowSize(model);
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
      compactionCount: sessionEntry.compactionCount,
      lastActiveAt: sessionEntry.updatedAt,
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
  console.log(`  Compacts:  ${sessionEntry.compactionCount}`);

  if (sessionEntry.updatedAt) {
    console.log(`  Last active: ${fmtDate(sessionEntry.updatedAt)}`);
  }

  console.log();
}
