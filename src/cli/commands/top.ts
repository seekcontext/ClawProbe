import fs from "fs";
import path from "path";
import chalk from "chalk";
import { ResolvedConfig } from "../../core/config.js";
import { openDb } from "../../core/db.js";
import { getActiveSession, findJsonlPath } from "../../core/session-store.js";
import { getLatestSnapshot } from "../../core/db.js";
import { parseSessionStats } from "../../core/jsonl-parser.js";
import { getPeriodCost, getSessionCostFromJsonl } from "../../engines/cost.js";
import { runRules, type ProbeState } from "../../engines/rule-engine.js";
import { fmtTokens, fmtUsd, fmtDate, tokenBar, severity, getWindowSize, LOCAL_TZ } from "../format.js";

interface TopOptions {
  agent?: string;
  interval?: string;
}

// ── ANSI helpers ─────────────────────────────────────────────────────────────

/** Move cursor to absolute row (1-based), column 1. */
const gotoRow = (row: number) => `\x1b[${row};1H`;
/** Clear from cursor to end of line. */
const clearEOL = "\x1b[K";
/** Clear from cursor to end of screen. */
const clearEOS = "\x1b[J";

function writeLine(row: number, text: string): void {
  process.stdout.write(gotoRow(row) + text + clearEOL);
}

// ── Utilities ─────────────────────────────────────────────────────────────────

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

function costPlain(usd: number): string {
  if (usd <= 0) return "$0.00";
  return `$${usd.toFixed(usd < 0.01 ? 4 : 2)}`;
}


function fmtDuration(sec: number | undefined): string {
  if (sec === undefined || sec <= 0) return "--";
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s > 0 ? `${m}m${s}s` : `${m}m`;
}

/**
 * Summarise the tools called in a single turn into a compact string that fits
 * within `maxWidth` visible characters.  Consecutive duplicates are collapsed
 * with a "×N" suffix (e.g. "Shell×3").  Any tools that don't fit are shown as
 * "+N more".  A "◆compact" badge is appended when a compaction occurred.
 * The latest-turn indicator is intentionally omitted — the row is already
 * rendered in white, which provides sufficient visual distinction.
 */
function fmtTurnTools(
  tools: string[],
  compactOccurred: boolean,
  maxWidth: number,
): string {
  // Collapse consecutive duplicates
  const parts: string[] = [];
  for (const name of tools) {
    const last = parts[parts.length - 1];
    if (last && last.startsWith(name)) {
      const match = last.match(/×(\d+)$/);
      if (match) {
        parts[parts.length - 1] = `${name}×${Number(match[1]) + 1}`;
      } else {
        parts[parts.length - 1] = `${name}×2`;
      }
    } else {
      parts.push(name);
    }
  }

  const badge = compactOccurred ? " ◆compact" : "";

  // Greedily include parts until we run out of width
  const budgetForTools = maxWidth - badge.length;
  let built = "";
  let shown = 0;
  for (const part of parts) {
    const sep = built.length > 0 ? " " : "";
    if (built.length + sep.length + part.length <= budgetForTools) {
      built += sep + part;
      shown++;
    } else {
      break;
    }
  }
  const remaining = parts.length - shown;
  if (remaining > 0) {
    built += ` +${remaining}`;
  }

  if (built.length === 0) return chalk.dim("—") + badge;
  return built + badge;
}

// ── Layout constants ──────────────────────────────────────────────────────────

/**
 * Fixed layout (row numbers, 1-based):
 *
 *   1   title bar
 *   2   ─── separator
 *   3   agent / daemon
 *   4   session
 *   5   model
 *   6   active / compacts
 *   7   ─── separator
 *   8   context bar
 *   9   headroom
 *  10   ─── separator
 *  11   cost row 1
 *  12   cost row 2
 *  13   ─── separator
 *  14   "Recent turns" heading
 *  15   column header
 *  16…  turn rows   (fills to termH - footerHeight)
 *  -N   alerts + disclaimer (footer, pinned to bottom)
 */
const HEADER_END_ROW = 15; // last fixed row before turns
const FOOTER_HEIGHT  = 4;  // rows reserved at the bottom (hr + up to 2 alert lines + disclaimer)

function render(cfg: ResolvedConfig, agent: string, intervalSec: number): void {
  const W    = process.stdout.columns || 80;
  const termH = process.stdout.rows   || 30;
  const hr   = chalk.dim("─".repeat(W));

  // ── Data ──────────────────────────────────────────────────────────────────
  const db           = openDb(cfg.probeDir);
  const daemonRunning = isDaemonRunning(cfg.probeDir);
  const sessionEntry  = getActiveSession(cfg.sessionsDir);
  const snapshot      = sessionEntry ? getLatestSnapshot(db, agent, sessionEntry.sessionKey) : null;
  const transcriptPath = sessionEntry ? findJsonlPath(cfg.sessionsDir, sessionEntry) : null;
  const jsonlStats    = transcriptPath ? parseSessionStats(transcriptPath) : null;

  const sessionTokens    = jsonlStats?.lastTotalTokens ?? sessionEntry?.sessionTokens ?? 0;
  const windowSize       = (sessionEntry?.windowSize || sessionEntry?.contextTokens) ?? 0;
  const model            = snapshot?.model ?? sessionEntry?.modelOverride ?? null;
  const resolvedWindowSize = getWindowSize(model, windowSize || sessionTokens);
  const utilization      = resolvedWindowSize > 0 ? sessionTokens / resolvedWindowSize : 0;

  let compactionCount = jsonlStats?.compactionCount ?? sessionEntry?.compactionCount ?? 0;
  let lastActiveAt    = jsonlStats?.lastActiveAt ?? sessionEntry?.updatedAt ?? 0;
  if (lastActiveAt === 0 && transcriptPath) {
    try { lastActiveAt = Math.floor(fs.statSync(transcriptPath).mtimeMs / 1000); } catch { /**/ }
  }

  const todaySummary = getPeriodCost(db, agent, "day", cfg.probe.cost.customPrices);
  const sessionCost  = jsonlStats
    ? getSessionCostFromJsonl(jsonlStats, sessionEntry?.sessionKey ?? "", cfg.probe.cost.customPrices)
    : null;

  const state: ProbeState = {
    db, agent,
    workspaceDir: cfg.workspaceDir,
    sessionsDir: cfg.sessionsDir,
    bootstrapMaxChars: cfg.bootstrapMaxChars,
    config: cfg.probe,
  };
  // Read-only: run rules but do NOT persist — top is a pure observer
  const suggestions = runRules(state);

  // ── Row 1: title bar ───────────────────────────────────────────────────────
  const ts       = nowStr();
  const titleText = `clawprobe top  refreshing every ${intervalSec}s  (q / Ctrl+C to quit)`;
  const titlePad = Math.max(0, W - titleText.length - ts.length);
  writeLine(1,
    chalk.bold("clawprobe top") +
    chalk.dim(`  refreshing every ${intervalSec}s  (q / Ctrl+C to quit)`) +
    " ".repeat(titlePad) +
    chalk.dim(ts)
  );

  // ── Row 2: separator ──────────────────────────────────────────────────────
  writeLine(2, hr);

  // ── Row 3: agent + daemon ─────────────────────────────────────────────────
  const daemonBadge = daemonRunning
    ? severity.ok("● daemon running")
    : severity.warning("○ daemon stopped — run: clawprobe start");
  writeLine(3, `  Agent: ${chalk.bold(agent)}   ${daemonBadge}`);

  if (!sessionEntry) {
    writeLine(4, "");
    writeLine(5, severity.muted("  No active session. Start OpenClaw and run a turn."));
    // Clear everything below
    process.stdout.write(gotoRow(6) + clearEOS);
    return;
  }

  // ── Row 4: session ────────────────────────────────────────────────────────
  const statusBadge = lastActiveAt && (Date.now() / 1000 - lastActiveAt < 120)
    ? severity.ok("● active")
    : severity.muted("○ idle");
  const keyShort = sessionEntry.sessionKey.length > W - 22
    ? sessionEntry.sessionKey.slice(0, W - 25) + "…"
    : sessionEntry.sessionKey;
  writeLine(4, `  Session: ${chalk.dim(keyShort)}  ${statusBadge}`);

  // ── Row 5: model ──────────────────────────────────────────────────────────
  writeLine(5, model ? `  Model:   ${model}` : "");

  // ── Row 6: active / compacts ──────────────────────────────────────────────
  writeLine(6, lastActiveAt
    ? `  Active:  ${fmtDate(lastActiveAt)}   Compacts: ${compactionCount}`
    : ""
  );

  // ── Row 7: separator ──────────────────────────────────────────────────────
  writeLine(7, hr);

  // ── Rows 8–9: context ─────────────────────────────────────────────────────
  if (sessionTokens > 0 && resolvedWindowSize > 0) {
    const pct      = Math.round(utilization * 100);
    const bar      = tokenBar(sessionTokens, resolvedWindowSize, 24);
    const ctxColor = utilization > 0.9 ? severity.critical : utilization > 0.7 ? severity.warning : (s: string) => s;
    writeLine(8, `  Context   ${bar}  ${ctxColor(`${pct}%`)}   ${fmtTokens(sessionTokens)} / ${fmtTokens(resolvedWindowSize)} tokens`);
    const remPct = 100 - pct;
    const remStr = `  Headroom  ${fmtTokens(resolvedWindowSize - sessionTokens)} tokens remaining (${remPct}%)`;
    writeLine(9, remPct < 10 ? severity.critical(remStr) : remPct < 25 ? severity.warning(remStr) : chalk.dim(remStr));
  } else {
    writeLine(8, severity.muted("  Context   n/a  (run a turn first)"));
    writeLine(9, "");
  }

  // ── Row 10: separator ─────────────────────────────────────────────────────
  writeLine(10, hr);

  // ── Rows 11–12: cost summary ──────────────────────────────────────────────
  const sessCost   = sessionCost?.estimatedUsd ?? 0;
  const inputTok   = sessionEntry.inputTokens;
  const outputTok  = sessionEntry.outputTokens;
  const cacheRead  = jsonlStats?.totalCacheRead  ?? 0;
  const cacheWrite = jsonlStats?.totalCacheWrite ?? 0;
  writeLine(11,
    `  Session cost  ${fmtUsd(sessCost).padEnd(12)}` +
    `  Input   ${fmtTokens(inputTok)} tok`.padEnd(22) +
    `  Output   ${fmtTokens(outputTok)} tok`
  );
  const cacheParts: string[] = [];
  if (cacheRead  > 0) cacheParts.push(`Cache read   ${fmtTokens(cacheRead)} tok`);
  if (cacheWrite > 0) cacheParts.push(`Cache write  ${fmtTokens(cacheWrite)} tok`);
  writeLine(12,
    `  Today total   ${fmtUsd(todaySummary.totalUsd).padEnd(12)}` +
    (cacheParts.length > 0 ? `  ${cacheParts.join("   ")}` : "")
  );

  // ── Row 13: separator ─────────────────────────────────────────────────────
  writeLine(13, hr);

  // ── Rows 14–15: turns heading + column header ─────────────────────────────
  // Column layout: Turn(6) Time(8) Dur(7) ΔIn(9) ΔOut(9) Cost(10) Tools(rest)
  // Prefix width (2 indent + fixed cols): 2 + 6 + 8 + 7 + 9 + 9 + 10 = 51
  const FIXED_PREFIX = 51;
  const toolsWidth = Math.max(12, W - FIXED_PREFIX);

  writeLine(14, chalk.bold("  Recent turns"));
  writeLine(15,
    chalk.dim("  " + ["Turn", "Time", "Dur", "ΔInput", "ΔOutput", "Cost", "Tools"]
      .map((h, i) => h.padEnd([6, 8, 7, 9, 9, 10, 0][i]!))
      .join(""))
  );

  // ── Turn rows: fill between row 16 and footer ─────────────────────────────
  const turnAreaStart = HEADER_END_ROW + 1; // 16
  const turnAreaEnd   = termH - FOOTER_HEIGHT; // last turn row
  const maxTurnRows   = Math.max(1, turnAreaEnd - turnAreaStart + 1);

  const turnList    = sessionCost?.turns ?? [];
  const recentTurns = turnList.slice(-maxTurnRows).reverse();

  recentTurns.forEach((turn, idx) => {
    const isLatest = idx === 0;
    const timeStr  = turn.timestamp > 0
      ? new Intl.DateTimeFormat("en-US", { timeZone: LOCAL_TZ, hour: "2-digit", minute: "2-digit", hour12: false })
          .format(new Date(turn.timestamp * 1000))
      : "--:--";

    const durStr    = fmtDuration(turn.durationSec);
    const toolsStr  = fmtTurnTools(turn.tools ?? [], turn.compactOccurred, toolsWidth);

    const line = "  " + [
      String(turn.turnIndex).padEnd(6),
      timeStr.padEnd(8),
      durStr.padEnd(7),
      fmtTokens(turn.inputTokensDelta).padEnd(9),
      fmtTokens(turn.outputTokensDelta).padEnd(9),
      costPlain(turn.estimatedUsd).padEnd(10),
      toolsStr,
    ].join("");
    writeLine(turnAreaStart + idx, isLatest ? chalk.white(line) : chalk.dim(line));
  });

  // Clear any leftover turn rows (if this render has fewer turns than last)
  for (let r = turnAreaStart + recentTurns.length; r <= turnAreaEnd; r++) {
    writeLine(r, "");
  }

  // ── Footer: pinned to bottom ──────────────────────────────────────────────
  const footerStart = termH - FOOTER_HEIGHT + 1;

  writeLine(footerStart, hr);

  // Alerts (up to 2 lines in footer — one line per alert, no action text)
  const alertLines: string[] = [];
  for (const s of suggestions.slice(0, 2)) {
    const icon = s.severity === "critical" ? "🔴" : s.severity === "warning" ? "🟡" : "🔵";
    alertLines.push(`  ${icon}  ${s.title}`);
  }
  if (suggestions.length > 2) {
    alertLines.push(chalk.dim(`     … +${suggestions.length - 2} more  →  clawprobe suggest`));
  }

  writeLine(footerStart + 1, alertLines[0] ?? "");
  writeLine(footerStart + 2, alertLines[1] ?? "");
  writeLine(footerStart + 3, chalk.dim("  Costs are estimates based on public pricing."));
}

export async function runTop(cfg: ResolvedConfig, opts: TopOptions): Promise<void> {
  const agent       = opts.agent ?? cfg.probe.openclaw.agent;
  const intervalSec = Math.max(1, parseInt(opts.interval ?? "2", 10));

  // Raw mode so 'q' registers immediately without Enter
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (key: string) => {
      if (key === "q" || key === "\u0003") {
        process.stdout.write("\x1b[?25h\x1b[?1049l"); // restore cursor + alt screen
        process.exit(0);
      }
    });
  }

  // Switch to alternate screen buffer (like htop/vim) — leaves original terminal intact on exit
  process.stdout.write("\x1b[?1049h");
  // Clear and hide cursor
  process.stdout.write("\x1b[2J\x1b[?25l");

  const restore = () => {
    process.stdout.write("\x1b[?25h\x1b[?1049l");
  };
  process.on("exit",   restore);
  process.on("SIGINT", () => { restore(); process.exit(0); });

  render(cfg, agent, intervalSec);
  setInterval(() => render(cfg, agent, intervalSec), intervalSec * 1000);

  // Re-render immediately on terminal resize
  process.on("SIGWINCH", () => render(cfg, agent, intervalSec));
}
