import chalk from "chalk";
import Table from "cli-table3";
import fsSync from "fs";
import osSync from "os";
export { MODEL_WINDOWS, getWindowSize } from "../core/model-windows.js";

// --- Colors & Severity ---

export const severity = {
  critical: (s: string) => chalk.red(s),
  warning: (s: string) => chalk.yellow(s),
  info: (s: string) => chalk.blue(s),
  ok: (s: string) => chalk.green(s),
  muted: (s: string) => chalk.gray(s),
  bold: (s: string) => chalk.bold(s),
  dim: (s: string) => chalk.dim(s),
};

export const SEVERITY_ICON: Record<string, string> = {
  critical: "🔴",
  warning:  "🟡",
  info:     "🔵",
};

// --- Token Bar ---

export function tokenBar(used: number, total: number, width = 20): string {
  const pct = Math.min(used / total, 1);
  const filled = Math.round(pct * width);
  const empty = width - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);
  const color = pct > 0.9 ? chalk.red : pct > 0.7 ? chalk.yellow : chalk.green;
  return color(bar);
}

// --- Cost Bar (for daily chart) ---

export function costBar(usd: number, maxUsd: number, width = 16): string {
  const pct = maxUsd > 0 ? Math.min(usd / maxUsd, 1) : 0;
  const filled = Math.round(pct * width);
  return chalk.cyan("█".repeat(filled)) + chalk.gray("░".repeat(width - filled));
}

// --- Number Formatting ---

export function fmtUsd(usd: number): string {
  if (usd === 0) return chalk.gray("$0.00");
  // Use enough decimal places so the value never rounds to zero
  let decimals = 2;
  if (usd < 0.01) decimals = 4;
  if (usd < 0.0001) decimals = 6;
  return chalk.green(`$${usd.toFixed(decimals)}`);
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// Resolve local timezone once at module load.
// Priority: TZ env var → ~/.clawprobe/config.json "timezone" → /etc/localtime symlink → Intl default
function resolveTimezone(): string {
  if (process.env.TZ) return process.env.TZ;

  // Try ~/.clawprobe/config.json "timezone" field
  try {
    const configPath = osSync.homedir() + "/.clawprobe/config.json";
    if (fsSync.existsSync(configPath)) {
      const cfg = JSON.parse(fsSync.readFileSync(configPath, "utf-8")) as Record<string, unknown>;
      if (typeof cfg["timezone"] === "string" && cfg["timezone"]) {
        return cfg["timezone"] as string;
      }
    }
  } catch { /**/ }

  // Try to derive from /etc/localtime symlink (Linux)
  try {
    const link = fsSync.readlinkSync("/etc/localtime");
    const m = link.match(/zoneinfo\/(.+)$/);
    if (m?.[1]) return m[1];
  } catch { /**/ }

  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export const LOCAL_TZ = resolveTimezone();

const _dateFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: LOCAL_TZ,
  month: "short",
  day: "numeric",
});
const _timeFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: LOCAL_TZ,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function fmtDate(ts: number): string {
  const d = new Date(ts * 1000);
  const now = new Date();

  // Compare calendar dates in local timezone.
  const dayOf = (dt: Date) =>
    new Intl.DateTimeFormat("en-US", { timeZone: LOCAL_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(dt);

  const isToday = dayOf(d) === dayOf(now);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = dayOf(d) === dayOf(yesterday);

  const timeStr = _timeFmt.format(d);
  if (isToday) return `Today ${timeStr}`;
  if (isYesterday) return `Yesterday ${timeStr}`;
  return `${_dateFmt.format(d)} ${timeStr}`;
}

export function fmtDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}min` : `${h}h`;
}

// --- Tables ---

/** Strip ANSI escape codes for accurate display width. */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Compute table column widths from header + rows.
 * Widths include the default left/right cell padding used by cli-table3.
 * Handles chalk-colored strings by stripping ANSI codes before measuring.
 */
export function computeColWidths(
  head: string[],
  rows: string[][],
  minWidths?: number[]
): number[] {
  const cellPadding = 2;
  const widths = head.map((h) => stripAnsi(h).length + cellPadding);
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      widths[i] = Math.max(widths[i] ?? 0, stripAnsi(String(row[i])).length + cellPadding);
    }
  }
  if (minWidths) {
    for (let i = 0; i < widths.length; i++) {
      widths[i] = Math.max(widths[i], (minWidths[i] ?? 0) + cellPadding);
    }
  }
  return widths;
}

export function makeTable(head: string[], colWidths?: number[]): Table.Table {
  const widths = colWidths ?? head.map(() => 16);
  return new Table({
    head: head.map((h) => chalk.bold.white(h)),
    colWidths: widths,
    style: {
      head: [],
      border: ["gray"],
    },
  });
}

// --- Section Headers ---

export function header(icon: string, title: string, subtitle?: string): void {
  console.log();
  console.log(`${icon}  ${chalk.bold(title)}${subtitle ? chalk.dim("  " + subtitle) : ""}`);
  console.log(chalk.dim("─".repeat(50)));
}

export function subheader(title: string): void {
  console.log(chalk.dim(`\n  ${title}`));
}

// --- Status Indicators ---

export function truncBadge(wasTruncated: boolean): string {
  return wasTruncated ? chalk.red("⚠ TRUNC") : chalk.green("✓ ok");
}

export function qualityBadge(quality: "good" | "partial" | "poor"): string {
  switch (quality) {
    case "good":    return chalk.green("✓ Summary adequate");
    case "partial": return chalk.yellow("⚠ Partial loss detected");
    case "poor":    return chalk.red("✗ Significant loss detected");
  }
}

// --- Role Icons ---

export function roleIcon(role: string): string {
  switch (role) {
    case "user":      return "👤";
    case "assistant": return "🤖";
    case "tool":      return "🔧";
    default:          return "•";
  }
}

// --- Divider ---

export function divider(): void {
  console.log(chalk.dim("─".repeat(50)));
}

// --- Cost disclaimer ---

export function printCostDisclaimer(): void {
  console.log(severity.muted("  Costs are estimates based on public pricing. Verify with your provider's billing dashboard."));
}

// --- JSON output helper ---

export function outputJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

// --- Error ---

export function printError(msg: string): void {
  console.error(chalk.red(`Error: ${msg}`));
}

export function printWarning(msg: string): void {
  console.error(chalk.yellow(`Warning: ${msg}`));
}

export function printSuccess(msg: string): void {
  console.log(chalk.green(`✅ ${msg}`));
}
