import fs from "fs";
import path from "path";
import chalk from "chalk";
import { ResolvedConfig } from "../../core/config.js";
import { openDb } from "../../core/db.js";
import { getActiveSession, findJsonlPath } from "../../core/session-store.js";
import { getLatestSnapshot } from "../../core/db.js";
import { parseSessionStats } from "../../core/jsonl-parser.js";
import { getPeriodCost, getSessionCostFromJsonl } from "../../engines/cost.js";
import { runRules, persistSuggestions, type ProbeState } from "../../engines/rule-engine.js";
import { fmtTokens, fmtUsd, fmtDate, tokenBar, severity, getWindowSize, LOCAL_TZ } from "../format.js";

interface TopOptions {
  agent?: string;
  interval?: string;
}

function isDaemonRunning(probeDir: string): boolean {
  const pidFile = path.join(probeDir, "daemon.pid");
  if (!fs.existsSync(pidFile)) return false;
  try {
    const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
    if (isNaN(pid)) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function nowStr(): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: LOCAL_TZ,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).format(new Date()).replace(",", "");
}

/** Lines written in the previous render — used to erase leftover lines. */
let _prevLineCount = 0;

/**
 * Flicker-free render: move to top-left, overwrite each line with \x1b[K (clear to EOL),
 * then blank any leftover lines from the previous (taller) render.
 */
function flushLines(lines: string[]): void {
  // Move to top-left without clearing
  process.stdout.write("\x1b[H");

  const out = lines.map((l) => l + "\x1b[K").join("\n") + "\n";
  process.stdout.write(out);

  // Erase lines that were present last render but not this one
  const leftover = _prevLineCount - lines.length;
  if (leftover > 0) {
    for (let i = 0; i < leftover; i++) {
      process.stdout.write("\x1b[K\n");
    }
  }
  _prevLineCount = lines.length;
}

function render(cfg: ResolvedConfig, agent: string, intervalSec: number): void {
  const db = openDb(cfg.probeDir);
  const daemonRunning = isDaemonRunning(cfg.probeDir);

  const sessionEntry = getActiveSession(cfg.sessionsDir);
  const snapshot = sessionEntry ? getLatestSnapshot(db, agent, sessionEntry.sessionKey) : null;
  const transcriptPath = sessionEntry ? findJsonlPath(cfg.sessionsDir, sessionEntry) : null;
  const jsonlStats = transcriptPath ? parseSessionStats(transcriptPath) : null;

  const sessionTokens = jsonlStats?.lastTotalTokens ?? sessionEntry?.sessionTokens ?? 0;
  const windowSize = (sessionEntry?.windowSize || sessionEntry?.contextTokens) ?? 0;
  const model = snapshot?.model ?? sessionEntry?.modelOverride ?? null;
  const resolvedWindowSize = getWindowSize(model, windowSize || sessionTokens);
  const utilization = resolvedWindowSize > 0 ? sessionTokens / resolvedWindowSize : 0;

  let compactionCount = jsonlStats?.compactionCount ?? sessionEntry?.compactionCount ?? 0;
  let lastActiveAt = jsonlStats?.lastActiveAt ?? sessionEntry?.updatedAt ?? 0;
  if (lastActiveAt === 0 && transcriptPath) {
    try { lastActiveAt = Math.floor(fs.statSync(transcriptPath).mtimeMs / 1000); } catch { /* ignore */ }
  }

  // Cost
  const todaySummary = getPeriodCost(db, agent, "day", cfg.probe.cost.customPrices);
  const sessionCost = jsonlStats
    ? getSessionCostFromJsonl(jsonlStats, sessionEntry?.sessionKey ?? "", cfg.probe.cost.customPrices)
    : null;

  // Suggestions
  const state: ProbeState = {
    db, agent,
    workspaceDir: cfg.workspaceDir,
    sessionsDir: cfg.sessionsDir,
    bootstrapMaxChars: cfg.bootstrapMaxChars,
    config: cfg.probe,
  };
  const suggestions = runRules(state);
  persistSuggestions(db, agent, suggestions);

  // ── Build lines buffer ────────────────────────────────────────────────────
  const lines: string[] = [];
  const W = process.stdout.columns || 80;
  const hr = chalk.dim("─".repeat(W));

  // Title row
  const titlePlain = `clawprobe top  refreshing every ${intervalSec}s  (q / Ctrl+C to quit)`;
  const ts = nowStr();
  const pad = Math.max(0, W - titlePlain.length - ts.length);
  lines.push(
    chalk.bold("clawprobe top") +
    chalk.dim(`  refreshing every ${intervalSec}s  (q / Ctrl+C to quit)`) +
    " ".repeat(pad) +
    chalk.dim(ts)
  );
  lines.push(hr);

  // Agent + daemon
  const daemonBadge = daemonRunning
    ? severity.ok("● daemon running")
    : severity.warning("○ daemon stopped — run: clawprobe start");
  lines.push(`  Agent: ${chalk.bold(agent)}   ${daemonBadge}`);

  if (!sessionEntry) {
    lines.push("");
    lines.push(severity.muted("  No active session. Start OpenClaw and run a turn."));
    lines.push("");
    flushLines(lines);
    return;
  }

  const statusBadge = lastActiveAt && (Date.now() / 1000 - lastActiveAt < 120)
    ? severity.ok("● active")
    : severity.muted("○ idle");
  const keyShort = sessionEntry.sessionKey.length > 52
    ? sessionEntry.sessionKey.slice(0, 49) + "…"
    : sessionEntry.sessionKey;

  lines.push(`  Session: ${chalk.dim(keyShort)}  ${statusBadge}`);
  if (model) lines.push(`  Model:   ${model}`);
  if (lastActiveAt) lines.push(`  Active:  ${fmtDate(lastActiveAt)}   Compacts: ${compactionCount}`);

  // Context bar
  lines.push("");
  lines.push(hr);
  if (sessionTokens > 0 && resolvedWindowSize > 0) {
    const pct = Math.round(utilization * 100);
    const bar = tokenBar(sessionTokens, resolvedWindowSize, 24);
    const ctxColor = utilization > 0.9 ? severity.critical : utilization > 0.7 ? severity.warning : (s: string) => s;
    lines.push(`  Context   ${bar}  ${ctxColor(`${pct}%`)}   ${fmtTokens(sessionTokens)} / ${fmtTokens(resolvedWindowSize)} tokens`);
    const remaining = resolvedWindowSize - sessionTokens;
    const remPct = 100 - pct;
    const remStr = `  Headroom  ${fmtTokens(remaining)} tokens remaining (${remPct}%)`;
    lines.push(remPct < 10 ? severity.critical(remStr) : remPct < 25 ? severity.warning(remStr) : chalk.dim(remStr));
  } else {
    lines.push(severity.muted("  Context   n/a  (run a turn first)"));
  }

  // Cost summary
  lines.push("");
  lines.push(hr);
  const sessCost = sessionCost?.estimatedUsd ?? 0;
  const todayCost = todaySummary.totalUsd;
  const inputTok = sessionEntry.inputTokens;
  const outputTok = sessionEntry.outputTokens;
  const cacheRead = jsonlStats?.totalCacheRead ?? 0;
  lines.push(
    `  Session cost  ${fmtUsd(sessCost).padEnd(12)}` +
    `  Input   ${fmtTokens(inputTok)} tok`.padEnd(22) +
    `  Output   ${fmtTokens(outputTok)} tok`
  );
  lines.push(
    `  Today total   ${fmtUsd(todayCost).padEnd(12)}` +
    (cacheRead > 0 ? `  Cache read   ${fmtTokens(cacheRead)} tok` : "")
  );

  // Recent turns — show as many as the terminal height allows
  const turnList = sessionCost?.turns ?? [];
  if (turnList.length > 0) {
    lines.push("");
    lines.push(hr);
    lines.push(chalk.bold("  Recent turns"));
    lines.push(
      chalk.dim("  " + ["Turn", "Time", "ΔInput", "ΔOutput", "Cost", "Note"].map((h, i) => h.padEnd([6, 10, 9, 9, 12, 0][i]!)).join(""))
    );

    // Reserve lines for: header block (~10) + separator + heading + col-header + footer (~3)
    // Fill the remaining terminal rows with turn rows (min 4, max all turns)
    const termH = process.stdout.rows || 30;
    const reservedLines = lines.length + 3; // footer lines below turns
    const maxTurnRows = Math.max(4, termH - reservedLines - 2);
    const recentTurns = turnList.slice(-maxTurnRows).reverse();

    recentTurns.forEach((turn, idx) => {
      const isLatest = idx === 0;
      const timeStr = turn.timestamp > 0
        ? new Intl.DateTimeFormat("en-US", { timeZone: LOCAL_TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(turn.timestamp * 1000))
        : "--:--";
      const note = turn.compactOccurred ? chalk.cyan("◆ compact") : isLatest ? chalk.dim("← latest") : "";
      // Use plain-text width for cost column to avoid ANSI code padding issues
      const costPlain = `$${turn.estimatedUsd > 0 ? turn.estimatedUsd.toFixed(turn.estimatedUsd < 0.01 ? 4 : 2) : "0.00"}`;
      const line = "  " + [
        String(turn.turnIndex).padEnd(6),
        timeStr.padEnd(10),
        fmtTokens(turn.inputTokensDelta).padEnd(9),
        fmtTokens(turn.outputTokensDelta).padEnd(9),
        costPlain.padEnd(12),
        note,
      ].join("");
      lines.push(isLatest ? chalk.white(line) : chalk.dim(line));
    });
  }

  // Alerts
  if (suggestions.length > 0) {
    lines.push("");
    lines.push(hr);
    for (const s of suggestions.slice(0, 3)) {
      const icon = s.severity === "critical" ? "🔴" : s.severity === "warning" ? "🟡" : "🔵";
      lines.push(`  ${icon}  ${s.title}`);
      if (s.action) lines.push(chalk.dim(`       → ${s.action}`));
    }
    if (suggestions.length > 3) {
      lines.push(chalk.dim(`     … +${suggestions.length - 3} more  →  clawprobe suggest`));
    }
  }

  lines.push("");
  lines.push(chalk.dim(`  Costs are estimates based on public pricing.  Last refresh: ${nowStr()}`));

  flushLines(lines);
}

export async function runTop(cfg: ResolvedConfig, opts: TopOptions): Promise<void> {
  const agent = opts.agent ?? cfg.probe.openclaw.agent;
  const intervalSec = Math.max(1, parseInt(opts.interval ?? "2", 10));

  // Disable stdin line buffering so 'q' can be detected immediately
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (key: string) => {
      if (key === "q" || key === "\u0003" /* Ctrl+C */) {
        // Restore cursor and exit cleanly
        process.stdout.write("\x1b[?25h"); // show cursor
        process.exit(0);
      }
    });
  }

  // Clear screen once on startup, then use flicker-free overwrite on each refresh
  process.stdout.write("\x1b[2J\x1b[H");
  // Hide cursor for cleaner rendering
  process.stdout.write("\x1b[?25l");

  // Restore cursor on unhandled exit
  process.on("exit", () => process.stdout.write("\x1b[?25h"));
  process.on("SIGINT", () => { process.stdout.write("\x1b[?25h"); process.exit(0); });

  // Initial render immediately, then on interval
  render(cfg, agent, intervalSec);
  setInterval(() => render(cfg, agent, intervalSec), intervalSec * 1000);
}
