import fs from "fs";
import path from "path";
import chalk from "chalk";
import { ResolvedConfig } from "../../core/config.js";
import {
  getActiveSession,
  findJsonlPath,
} from "../../core/session-store.js";
import {
  startLiveStream,
  findMostRecentJsonl,
  getToolIcon,
  type LiveEvent,
} from "../../core/live-stream.js";
import { LOCAL_TZ } from "../format.js";

interface LiveOptions {
  agent?: string;
  history?: boolean;
  file?: string;
}

// ── Formatting helpers ────────────────────────────────────────────────────────

function fmtTime(ms: number): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: LOCAL_TZ,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(ms));
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// ── Event renderer ────────────────────────────────────────────────────────────

/**
 * Returns the string to print for a given LiveEvent, or null to skip.
 * The W parameter is the terminal width for truncating long summaries.
 */
function renderEvent(event: LiveEvent, W: number): string | null {
  const time = fmtTime(event.timestamp);
  // Invisible padding matching the time string length for continuation lines
  const pad = " ".repeat(time.length);

  switch (event.kind) {
    case "turn_start":
      return (
        "\n" +
        chalk.bold(`  ${time}  ● Turn ${event.turnIndex ?? "?"}`)
      );

    case "thinking":
      if (event.thinkingContent) {
        // Actual thinking content from JSONL — show a snippet
        const maxLen = Math.max(20, W - 14);
        const snippet = event.thinkingContent.slice(0, maxLen);
        return chalk.dim(`  ${time}  💭 ${snippet}`);
      }
      // Speculative indicator — model is thinking but hasn't written to JSONL yet
      return chalk.dim(`  ${pad}  🤔 thinking...`);

    case "tool_call": {
      const icon = getToolIcon(event.tool ?? "");
      const nameRaw = event.tool ?? "unknown";
      // Pad to align summaries: use 16 chars to accommodate OpenClaw names like "memory_search"
      const PAD = 16;
      const namePadded = nameRaw + " ".repeat(Math.max(0, PAD - nameRaw.length));
      const name = chalk.cyan(namePadded);
      const maxSummaryLen = Math.max(15, W - (10 + PAD + 6));
      const summary = event.toolSummary
        ? chalk.dim(event.toolSummary.slice(0, maxSummaryLen))
        : "";
      return `  ${time}  ${icon} ${name}${summary}`;
    }

    case "tool_result":
      // Only surface errors — success is implicit and would be too noisy
      if (event.toolError) {
        return chalk.red(`  ${pad}                  ✗  error`);
      }
      return null;

    case "turn_end": {
      const toks = event.tokensOut
        ? chalk.dim(`  +${fmtTokens(event.tokensOut)} tok`)
        : "";
      return chalk.green(`  ${time}  ● done${toks}`);
    }

    case "compaction":
      return chalk.yellow(`  ${time}  ◆ compact  (context summarized)`);

    case "subagent_start": {
      const summary = event.toolSummary
        ? chalk.dim(`  ${event.toolSummary.slice(0, Math.max(15, W - 38))}`)
        : "";
      return chalk.magenta(`  ${time}  🤖 subagent${summary}`);
    }

    // session_start is printed as a header block by the main loop
    case "session_start":
      return null;

    default:
      return null;
  }
}

// ── Session header ────────────────────────────────────────────────────────────

function printSessionHeader(
  sessionKey: string,
  jsonlPath: string,
  W: number
): void {
  const hr = chalk.dim("─".repeat(W));
  const maxKeyLen = W - 14;
  const shortKey =
    sessionKey.length > maxKeyLen
      ? sessionKey.slice(0, maxKeyLen - 3) + "…"
      : sessionKey;
  const fileName = path.basename(jsonlPath);

  console.log(hr);
  console.log(`  ${chalk.bold("Session:")} ${chalk.dim(shortKey)}`);
  console.log(chalk.dim(`  file: ${fileName}`));
  console.log(hr);
}

// ── Main command ──────────────────────────────────────────────────────────────

export async function runLive(
  cfg: ResolvedConfig,
  opts: LiveOptions
): Promise<void> {
  const W = process.stdout.columns || 80;
  const hr = chalk.dim("─".repeat(W));

  // Title bar
  const nowStr = new Intl.DateTimeFormat("en-US", {
    timeZone: LOCAL_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
    .format(new Date())
    .replace(",", "");

  const titleText = "clawprobe live  streaming  (q / Ctrl+C to quit)";
  const titlePad = Math.max(0, W - titleText.length - nowStr.length);
  console.log(
    chalk.bold("clawprobe live") +
      chalk.dim("  streaming  (q / Ctrl+C to quit)") +
      " ".repeat(titlePad) +
      chalk.dim(nowStr)
  );
  console.log(hr);
  console.log();

  // ── Resolve JSONL path ──────────────────────────────────────────────────────

  let jsonlPath: string | null = null;

  // Explicit --file override
  if (opts.file) {
    if (!fs.existsSync(opts.file)) {
      console.error(chalk.red(`Error: file not found: ${opts.file}`));
      process.exit(1);
    }
    jsonlPath = opts.file;
  } else {
    // Auto-detect: prefer sessions.json active session, fall back to most recent file
    const sessionEntry = getActiveSession(cfg.sessionsDir);
    if (sessionEntry) {
      jsonlPath = findJsonlPath(cfg.sessionsDir, sessionEntry);
    }
    if (!jsonlPath) {
      jsonlPath = findMostRecentJsonl(cfg.sessionsDir);
    }
  }

  if (!jsonlPath) {
    console.log(
      chalk.dim(
        "  No active session found.\n" +
          "  Start OpenClaw, send a message, then run clawprobe live again."
      )
    );
    return;
  }

  // Determine session key for display
  const sessionEntry = getActiveSession(cfg.sessionsDir);
  const displayKey =
    sessionEntry?.sessionKey ?? path.basename(jsonlPath, ".jsonl");

  printSessionHeader(displayKey, jsonlPath, W);

  if (opts.history) {
    console.log(chalk.dim("  (replaying history…)\n"));
  } else {
    console.log(
      chalk.dim("  Watching for new events. Start an OpenClaw turn to see activity.\n")
    );
  }

  // ── Keyboard: quit on 'q' or Ctrl+C ────────────────────────────────────────

  const controller = new AbortController();

  function quit() {
    controller.abort();
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
      } catch { /* ignore */ }
    }
    process.stdin.pause();
    console.log("\n" + chalk.dim("  stopped."));
    process.exit(0);
  }

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (key: string) => {
      if (key === "q" || key === "\u0003") quit();
    });
  }

  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);

  // ── Stream loop ─────────────────────────────────────────────────────────────

  await startLiveStream(
    jsonlPath,
    (event: LiveEvent) => {
      const line = renderEvent(event, W);
      if (line !== null) {
        console.log(line);
      }
    },
    controller.signal,
    !opts.history  // skipHistory = true unless --history flag is set
  );
}
