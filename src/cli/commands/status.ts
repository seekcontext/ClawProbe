import fs from "fs";
import path from "path";
import { ResolvedConfig } from "../../core/config.js";
import { openDb } from "../../core/db.js";
import { getActiveSession, readSessionsStore, findJsonlPath } from "../../core/session-store.js";
import { getLatestSnapshot } from "../../core/db.js";
import { parseSessionStats } from "../../core/jsonl-parser.js";
import { getPeriodCost } from "../../engines/cost.js";
import { runRules, persistSuggestions, type ProbeState } from "../../engines/rule-engine.js";
import {
  header, fmtTokens, fmtDate, fmtUsd, tokenBar, outputJson, severity,
  getWindowSize,
} from "../format.js";

interface StatusOptions {
  agent?: string;
  session?: string;
  json?: boolean;
}

function isDaemonRunning(probeDir: string): boolean {
  const pidFile = path.join(probeDir, "daemon.pid");
  if (!fs.existsSync(pidFile)) return false;
  try {
    const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
    if (isNaN(pid)) return false;
    process.kill(pid, 0); // throws if process doesn't exist
    return true;
  } catch {
    return false;
  }
}

export async function runStatus(cfg: ResolvedConfig, opts: StatusOptions): Promise<void> {
  const agent = opts.agent ?? cfg.probe.openclaw.agent;
  const db = openDb(cfg.probeDir);

  let sessionEntry = opts.session
    ? readSessionsStore(cfg.sessionsDir).find((s) => s.sessionKey === opts.session)
    : getActiveSession(cfg.sessionsDir);

  const snapshot = sessionEntry
    ? getLatestSnapshot(db, agent, sessionEntry.sessionKey)
    : null;

  const transcriptPath = sessionEntry ? findJsonlPath(cfg.sessionsDir, sessionEntry) : null;
  const jsonlStats = transcriptPath ? parseSessionStats(transcriptPath) : null;

  const sessionTokens = jsonlStats?.lastTotalTokens ?? sessionEntry?.sessionTokens ?? 0;
  const windowSize = (sessionEntry?.windowSize || sessionEntry?.contextTokens) ?? 0;

  let compactionCount = jsonlStats?.compactionCount ?? sessionEntry?.compactionCount ?? 0;
  let lastActiveAt = jsonlStats?.lastActiveAt ?? sessionEntry?.updatedAt ?? 0;
  if (lastActiveAt === 0 && transcriptPath) {
    try { lastActiveAt = Math.floor(fs.statSync(transcriptPath).mtimeMs / 1000); } catch { /* ignore */ }
  }

  const model = snapshot?.model ?? sessionEntry?.modelOverride ?? null;
  const resolvedWindowSize = getWindowSize(model, windowSize || sessionTokens);
  const displayContextTokens = sessionTokens > 0 ? sessionTokens : 0;
  const utilization = resolvedWindowSize > 0 ? displayContextTokens / resolvedWindowSize : 0;
  const isActive = !opts.session;

  // Today's cost
  const todaySummary = getPeriodCost(db, agent, "day", cfg.probe.cost.customPrices);

  // Suggestions (run rules, top 2)
  const state: ProbeState = {
    db, agent,
    workspaceDir: cfg.workspaceDir,
    sessionsDir: cfg.sessionsDir,
    bootstrapMaxChars: cfg.bootstrapMaxChars,
    config: cfg.probe,
  };
  const suggestions = runRules(state);
  persistSuggestions(db, agent, suggestions);

  const daemonRunning = isDaemonRunning(cfg.probeDir);

  if (opts.json) {
    outputJson({
      agent,
      daemonRunning,
      sessionKey: sessionEntry?.sessionKey ?? null,
      sessionId: sessionEntry?.sessionId ?? null,
      model,
      provider: snapshot?.provider ?? sessionEntry?.providerOverride ?? null,
      sessionTokens: displayContextTokens,
      windowSize: resolvedWindowSize,
      utilizationPct: Math.round(utilization * 100),
      inputTokens: sessionEntry?.inputTokens ?? 0,
      outputTokens: sessionEntry?.outputTokens ?? 0,
      compactionCount,
      lastActiveAt,
      isActive,
      todayUsd: todaySummary.totalUsd,
      suggestions: suggestions.map((s) => ({
        severity: s.severity,
        ruleId: s.ruleId,
        title: s.title,
        detail: s.detail,
        action: s.action ?? null,
      })),
    });
    return;
  }

  header("📊", "Agent Status", isActive ? "(active session)" : `session: ${sessionEntry?.sessionKey}`);

  // ── Daemon ────────────────────────────────────────────────────────────────
  const daemonLine = daemonRunning
    ? severity.ok("  ● daemon running")
    : severity.warning("  ○ daemon not running  →  run: clawprobe start");
  console.log(daemonLine);

  // ── Session ───────────────────────────────────────────────────────────────
  if (!sessionEntry) {
    console.log();
    console.log(severity.muted("  No active session. Start OpenClaw and run a turn to populate data."));
    console.log();
    return;
  }

  console.log();
  console.log(`  Agent:     ${severity.bold(agent)}`);
  console.log(`  Session:   ${severity.muted(sessionEntry.sessionKey)}${isActive ? " ●" : ""}`);
  if (model) console.log(`  Model:     ${model}`);
  if (lastActiveAt) console.log(`  Active:    ${fmtDate(lastActiveAt)}`);
  console.log(`  Compacts:  ${compactionCount}`);

  // ── Context ───────────────────────────────────────────────────────────────
  console.log();
  if (displayContextTokens > 0) {
    const pct = Math.round(utilization * 100);
    const bar = tokenBar(displayContextTokens, resolvedWindowSize);
    const ctxColor = utilization > 0.9 ? severity.critical : utilization > 0.7 ? severity.warning : (s: string) => s;
    console.log(
      `  Context:   ${ctxColor(`${fmtTokens(displayContextTokens)} / ${fmtTokens(resolvedWindowSize)}`)}  ${bar}  ${pct}%`
    );
  } else {
    console.log(`  Context:   ${severity.muted("n/a  (run a turn first)")}`);
  }
  console.log(
    `  Tokens:    ${fmtTokens(sessionEntry.inputTokens)} in / ${fmtTokens(sessionEntry.outputTokens)} out`
  );

  // ── Today's cost ──────────────────────────────────────────────────────────
  console.log();
  if (todaySummary.totalUsd > 0) {
    console.log(`  Today:     ${fmtUsd(todaySummary.totalUsd)}  ${severity.muted("→ clawprobe cost for full breakdown")}`);
  } else {
    console.log(`  Today:     ${severity.muted("$0.00  (no cost data yet)")}`);
  }

  // ── Suggestions ───────────────────────────────────────────────────────────
  if (suggestions.length > 0) {
    console.log();
    const top = suggestions.slice(0, 3);
    for (const s of top) {
      const icon = s.severity === "critical" ? "🔴" : s.severity === "warning" ? "🟡" : "🔵";
      console.log(`  ${icon}  ${s.title}`);
    }
    if (suggestions.length > 3) {
      console.log(severity.muted(`     … +${suggestions.length - 3} more  →  clawprobe suggest`));
    } else {
      console.log(severity.muted(`     →  clawprobe suggest  for details & actions`));
    }
  }

  if (
    sessionEntry.inputTokens === 0 &&
    sessionEntry.outputTokens === 0 &&
    transcriptPath !== null
  ) {
    console.log();
    console.log(severity.muted("  Token counts not yet available — run a turn or check your OpenClaw version."));
  }

  console.log();
}
