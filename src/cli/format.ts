import chalk from "chalk";
import Table from "cli-table3";

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
  return chalk.green(`$${usd.toFixed(2)}`);
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function fmtDate(ts: number): string {
  const d = new Date(ts * 1000);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();

  const timeStr = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (isToday) return `Today ${timeStr}`;
  if (isYesterday) return `Yesterday ${timeStr}`;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${timeStr}`;
}

export function fmtDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}min` : `${h}h`;
}

// --- Tables ---

export function makeTable(head: string[], colWidths?: number[]): Table.Table {
  return new Table({
    head: head.map((h) => chalk.bold.white(h)),
    colWidths,
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
