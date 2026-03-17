import chalk from "chalk";
import Table from "cli-table3";

// --- Model context window sizes ---
// Keys are lowercased substrings to match against model identifiers.
// Listed from most-specific to least-specific so the first match wins.
export const MODEL_WINDOWS: [string, number][] = [
  // ── Anthropic ──────────────────────────────────────────────────────────
  ["claude-opus-4",         200_000],
  ["claude-sonnet-4",       200_000],  // covers sonnet-4, sonnet-4.5
  ["claude-haiku-4",        200_000],
  ["claude-3-5-sonnet",     200_000],
  ["claude-3-5-haiku",      200_000],
  ["claude-3-opus",         200_000],
  ["claude-3-sonnet",       200_000],
  ["claude-3-haiku",        200_000],
  ["claude-2",              100_000],
  ["claude-instant",        100_000],
  ["claude",                200_000],  // generic claude fallback

  // ── OpenAI ─────────────────────────────────────────────────────────────
  ["gpt-5.4-mini",          128_000],
  ["gpt-5.4",               128_000],
  ["o4-mini",               128_000],
  ["o4",                    128_000],
  ["o3-mini",               128_000],
  ["o3",                    128_000],
  ["gpt-4o-mini",           128_000],
  ["gpt-4o",                128_000],
  ["gpt-4-turbo",           128_000],
  ["gpt-4",                 128_000],
  ["gpt-3.5",                16_385],

  // ── Google ─────────────────────────────────────────────────────────────
  ["gemini-3.1-flash",    1_000_000],
  ["gemini-3.1-pro",      1_000_000],
  ["gemini-2.0-flash",    1_000_000],
  ["gemini-2.0-pro",      1_000_000],
  ["gemini-1.5-flash",    1_000_000],
  ["gemini-1.5-pro",      1_000_000],
  ["gemini",              1_000_000],  // generic gemini fallback

  // ── DeepSeek ───────────────────────────────────────────────────────────
  ["deepseek-v3.2",         131_000],  // V3.2-exp
  ["deepseek-r2",           128_000],
  ["deepseek-v3",           128_000],
  ["deepseek-r1",           128_000],
  ["deepseek",              128_000],

  // ── Moonshot / Kimi ────────────────────────────────────────────────────
  ["kimi-k2.5",             256_000],
  ["kimi-k2",               256_000],
  ["kimi-vl",               128_000],
  ["kimi",                  128_000],  // generic kimi fallback
  ["moonshot-v1-128k",      128_000],
  ["moonshot-v1-32k",        32_000],
  ["moonshot-v1-8k",          8_000],
  ["moonshot",              128_000],

  // ── Qwen / Alibaba ─────────────────────────────────────────────────────
  ["qwen-long",          10_000_000],  // Qwen-Long: up to 10M tokens
  ["qwen3-coder-plus",    1_000_000],
  ["qwen3-coder",           256_000],  // native; supports 1M with YaRN
  ["qwen-plus",           1_000_000],
  ["qwen-turbo",          1_000_000],
  ["qwen-flash",          1_000_000],
  ["qwen3-max",             256_000],
  ["qwen3",                 256_000],  // generic qwen3
  ["qwen2.5",               128_000],
  ["qwen2",                 128_000],
  ["qwen",                  128_000],  // generic qwen fallback

  // ── MiniMax ────────────────────────────────────────────────────────────
  ["minimax-text-01",     4_000_000],  // 4M inference context
  ["minimax-01",          4_000_000],
  ["minimax",             4_000_000],  // generic minimax fallback

  // ── Zhipu / GLM ────────────────────────────────────────────────────────
  ["glm-5",                 200_000],
  ["glm-4.7",               200_000],
  ["glm-4.6",               200_000],
  ["glm-4.5",               128_000],
  ["glm-4",                 128_000],
  ["glm",                   128_000],  // generic glm fallback

  // ── ByteDance / Doubao ─────────────────────────────────────────────────
  ["seed-code",             256_000],
  ["seed-2.0",              256_000],
  ["seed",                  256_000],
  ["doubao-pro-128k",       128_000],
  ["doubao-pro-32k",         32_000],
  ["doubao",                128_000],  // generic doubao fallback

  // ── Baidu / ERNIE ──────────────────────────────────────────────────────
  ["ernie-5",               128_000],
  ["ernie-4.5",             128_000],
  ["ernie-4",               128_000],
  ["ernie-3.5",             128_000],
  ["ernie",                 128_000],  // generic ernie fallback

  // ── Mistral ────────────────────────────────────────────────────────────
  ["mixtral",                32_000],
  ["mistral",                32_000],
];

/**
 * Returns the context window size for a given model identifier.
 * Falls back to the contextTokens value itself if it exceeds all known windows
 * (avoids showing ">100%" when OpenClaw reports a larger-than-default context).
 */
export function getWindowSize(model: string | null, contextTokens = 0): number {
  if (model) {
    const lower = model.toLowerCase();
    const match = MODEL_WINDOWS.find(([key]) => lower.includes(key));
    if (match) {
      // If the reported context already exceeds this window, trust the context.
      return Math.max(match[1], contextTokens);
    }
  }
  // Unknown model: use the larger of 200K default and whatever was reported.
  return Math.max(200_000, contextTokens);
}

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
