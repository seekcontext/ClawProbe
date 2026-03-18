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

function clearScreen(): void {
  // Move cursor to top-left and clear screen
  process.stdout.write("\x1b[H\x1b[2J");
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

  // ── Render ────────────────────────────────────────────────────────────────
  clearScreen();

  const W = process.stdout.columns || 80;
  const hr = chalk.dim("─".repeat(W));
  const title = chalk.bold("clawprobe top");
  const hint = chalk.dim(`  refreshing every ${intervalSec}s  (q / Ctrl+C to quit)`);
  const ts = chalk.dim(nowStr());

  // Title row: left-align title+hint, right-align timestamp
  const titleRow = title + hint;
  const titleRowLen = `clawprobe top  refreshing every ${intervalSec}s  (q / Ctrl+C to quit)`.length;
  const pad = Math.max(0, W - titleRowLen - nowStr().length);
  console.log(titleRow + " ".repeat(pad) + ts);
  console.log(hr);

  // ── Daemon + Agent ────────────────────────────────────────────────────────
  const daemonBadge = daemonRunning
    ? severity.ok("● daemon running")
    : severity.warning("○ daemon stopped — run: clawprobe start");

  console.log(`  Agent: ${chalk.bold(agent)}   ${daemonBadge}`);

  if (!sessionEntry) {
    console.log();
    console.log(severity.muted("  No active session. Start OpenClaw and run a turn."));
    console.log();
    return;
  }

  const statusBadge = lastActiveAt && (Date.now() / 1000 - lastActiveAt < 120)
    ? severity.ok("● active")
    : severity.muted("○ idle");

  const keyShort = sessionEntry.sessionKey.length > 52
    ? sessionEntry.sessionKey.slice(0, 49) + "…"
    : sessionEntry.sessionKey;

  console.log(`  Session: ${chalk.dim(keyShort)}  ${statusBadge}`);
  if (model) console.log(`  Model:   ${model}`);
  if (lastActiveAt) console.log(`  Active:  ${fmtDate(lastActiveAt)}   Compacts: ${compactionCount}`);

  // ── Context bar ───────────────────────────────────────────────────────────
  console.log();
  console.log(hr);

  if (sessionTokens > 0 && resolvedWindowSize > 0) {
    const pct = Math.round(utilization * 100);
    const bar = tokenBar(sessionTokens, resolvedWindowSize, 24);
    const ctxColor = utilization > 0.9 ? severity.critical : utilization > 0.7 ? severity.warning : (s: string) => s;
    console.log(
      `  Context   ${bar}  ${ctxColor(`${pct}%`)}` +
      `   ${fmtTokens(sessionTokens)} / ${fmtTokens(resolvedWindowSize)} tokens`
    );
    const remaining = resolvedWindowSize - sessionTokens;
    const remPct = 100 - pct;
    const remStr = `  Headroom  ${fmtTokens(remaining)} tokens remaining (${remPct}%)`;
    console.log(remPct < 10 ? severity.critical(remStr) : remPct < 25 ? severity.warning(remStr) : chalk.dim(remStr));
  } else {
    console.log(severity.muted("  Context   n/a  (run a turn first)"));
  }

  // ── Cost summary ──────────────────────────────────────────────────────────
  console.log();
  console.log(hr);

  const sessCost = sessionCost?.estimatedUsd ?? 0;
  const todayCost = todaySummary.totalUsd;
  const inputTok = sessionEntry.inputTokens;
  const outputTok = sessionEntry.outputTokens;
  const cacheRead = jsonlStats?.totalCacheRead ?? 0;

  console.log(
    `  Session cost  ${fmtUsd(sessCost).padEnd(12)}` +
    `  Input   ${fmtTokens(inputTok)} tok`.padEnd(22) +
    `  Output   ${fmtTokens(outputTok)} tok`
  );
  console.log(
    `  Today total   ${fmtUsd(todayCost).padEnd(12)}` +
    (cacheRead > 0 ? `  Cache read   ${fmtTokens(cacheRead)} tok` : "")
  );

  // ── Recent turns ──────────────────────────────────────────────────────────
  const turnList = sessionCost?.turns ?? [];
  if (turnList.length > 0) {
    console.log();
    console.log(hr);
    console.log(chalk.bold("  Recent turns"));
    console.log(
      chalk.dim("  " + ["Turn", "Time", "ΔInput", "ΔOutput", "Cost", "Note"].map((h, i) => h.padEnd([6, 10, 9, 9, 10, 0][i]!)).join(""))
    );

    const recentTurns = turnList.slice(-6).reverse();

    recentTurns.forEach((turn, idx) => {
      const isLatest = idx === 0;
      const timeStr = turn.timestamp > 0
        ? new Intl.DateTimeFormat("en-US", { timeZone: LOCAL_TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(turn.timestamp * 1000))
        : "--:--";

      const note = turn.compactOccurred ? chalk.cyan("◆ compact") : isLatest ? chalk.dim("← latest") : "";
      const costStr = fmtUsd(turn.estimatedUsd);

      const line = "  " + [
        String(turn.turnIndex).padEnd(6),
        timeStr.padEnd(10),
        fmtTokens(turn.inputTokensDelta).padEnd(9),
        fmtTokens(turn.outputTokensDelta).padEnd(9),
        costStr.padEnd(10),
        note,
      ].join("");

      console.log(isLatest ? chalk.white(line) : chalk.dim(line));
    });
  }

  // ── Alerts ────────────────────────────────────────────────────────────────
  if (suggestions.length > 0) {
    console.log();
    console.log(hr);
    for (const s of suggestions.slice(0, 3)) {
      const icon = s.severity === "critical" ? "🔴" : s.severity === "warning" ? "🟡" : "🔵";
      console.log(`  ${icon}  ${s.title}`);
      if (s.action) console.log(chalk.dim(`       → ${s.action}`));
    }
    if (suggestions.length > 3) {
      console.log(chalk.dim(`     … +${suggestions.length - 3} more  →  clawprobe suggest`));
    }
  }

  console.log();
  console.log(chalk.dim(`  Costs are estimates based on public pricing.  Last refresh: ${nowStr()}`));
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

  // Hide cursor for cleaner rendering
  process.stdout.write("\x1b[?25l");

  // Restore cursor on unhandled exit
  process.on("exit", () => process.stdout.write("\x1b[?25h"));
  process.on("SIGINT", () => { process.stdout.write("\x1b[?25h"); process.exit(0); });

  // Initial render immediately, then on interval
  render(cfg, agent, intervalSec);
  setInterval(() => render(cfg, agent, intervalSec), intervalSec * 1000);
}
