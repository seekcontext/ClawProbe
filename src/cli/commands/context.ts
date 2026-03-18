import { ResolvedConfig } from "../../core/config.js";
import { openDb } from "../../core/db.js";
import { getActiveSession, findJsonlPath } from "../../core/session-store.js";
import { parseSessionStats } from "../../core/jsonl-parser.js";
import { analyzeWorkspaceFiles } from "../../engines/file-analyzer.js";
import {
  header, fmtTokens, tokenBar, outputJson, severity, getWindowSize,
} from "../format.js";

interface ContextOptions {
  agent?: string;
  json?: boolean;
}

export async function runContext(cfg: ResolvedConfig, opts: ContextOptions): Promise<void> {
  const agent = opts.agent ?? cfg.probe.openclaw.agent;
  const db = openDb(cfg.probeDir);

  const activeSession = getActiveSession(cfg.sessionsDir);
  const transcriptPath = activeSession ? findJsonlPath(cfg.sessionsDir, activeSession) : null;
  const jsonlStats = transcriptPath ? parseSessionStats(transcriptPath) : null;

  const sessionTokens = jsonlStats?.lastTotalTokens ?? activeSession?.sessionTokens ?? 0;
  const windowSize = (activeSession?.windowSize || activeSession?.contextTokens) ?? 0;
  const model = jsonlStats?.model ?? activeSession?.modelOverride ?? null;
  const resolvedWindowSize = getWindowSize(model, windowSize || sessionTokens);

  // Workspace analysis: just the token overhead summary, no per-file table
  const analysis = analyzeWorkspaceFiles(cfg.workspaceDir, cfg.bootstrapMaxChars);
  const wsTotalInjectedTokens = analysis.files.reduce((s, f) => s + f.injectedEstTokens, 0);
  const sessionHistoryTokens = sessionTokens > wsTotalInjectedTokens
    ? sessionTokens - wsTotalInjectedTokens
    : sessionTokens > 0 ? sessionTokens : 0;

  if (opts.json) {
    outputJson({
      agent,
      sessionTokens,
      windowSize: resolvedWindowSize,
      utilizationPct: resolvedWindowSize > 0 ? Math.round(sessionTokens / resolvedWindowSize * 100) : 0,
      workspaceOverheadTokensEst: wsTotalInjectedTokens,
      sessionHistoryTokensEst: sessionHistoryTokens,
      truncatedFiles: analysis.truncatedFiles.map((f) => ({
        name: f.name,
        lostPct: Math.round(f.lostPercent),
      })),
    });
    return;
  }

  header("🔍", "Context Window", `agent: ${agent}`);

  // ── Overall context bar ──────────────────────────────────────────────────
  if (sessionTokens > 0) {
    const pct = Math.round(sessionTokens / resolvedWindowSize * 100);
    const ctxColor = pct > 90 ? severity.critical : pct > 70 ? severity.warning : (s: string) => s;
    console.log(
      `  Used:    ${ctxColor(`${fmtTokens(sessionTokens)} / ${fmtTokens(resolvedWindowSize)} tokens`)}` +
      `  ${tokenBar(sessionTokens, resolvedWindowSize)}  ${pct}%`
    );
  } else {
    console.log(severity.muted(`  Context window: ${fmtTokens(resolvedWindowSize)} tokens  (no session data yet)`));
    console.log();
    console.log(severity.muted("  Start OpenClaw and run a turn, then try again."));
    console.log();
    return;
  }

  // ── Breakdown ────────────────────────────────────────────────────────────
  console.log();
  console.log(`  Workspace overhead:  ~${fmtTokens(wsTotalInjectedTokens)} tokens  ${severity.muted(`(${analysis.files.length} injected files)`)}`);
  console.log(`  Conversation est:    ~${fmtTokens(sessionHistoryTokens)} tokens  ${severity.muted("(messages + system prompt + tools)")}`);

  // ── Truncation warnings ──────────────────────────────────────────────────
  if (analysis.truncatedFiles.length > 0) {
    console.log();
    for (const f of analysis.truncatedFiles) {
      console.log(
        severity.warning(`  ⚠ ${f.name}: ${Math.round(f.lostPercent)}% truncated — model never sees this content`)
      );
    }
    console.log(severity.muted("    Run: clawprobe context --json  or increase bootstrapMaxChars in openclaw.json"));
  }

  // ── Remaining headroom ────────────────────────────────────────────────────
  if (resolvedWindowSize > 0) {
    const remaining = resolvedWindowSize - sessionTokens;
    const remainingPct = Math.round(remaining / resolvedWindowSize * 100);
    console.log();
    const headroomStr = `  Remaining:  ${fmtTokens(remaining)} tokens (${remainingPct}%)`;
    if (remainingPct < 10) {
      console.log(severity.critical(headroomStr));
      console.log(severity.warning("  ⚠ Less than 10% remaining — compaction or new session recommended"));
    } else if (remainingPct < 25) {
      console.log(severity.warning(headroomStr));
    } else {
      console.log(headroomStr);
    }
  }

  console.log();
}
