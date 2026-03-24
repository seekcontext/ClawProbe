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

export type LiveDensity = "compact" | "normal" | "verbose";

interface LiveOptions {
  agent?: string;
  history?: boolean;
  file?: string;
  density?: LiveDensity;
  plain?: boolean;
}

interface LiveGlyphs {
  turn: string;
  done: string;
  compact: string;
  subagent: string;
  tree: string;
  reasoning: string;
  awaiting: string;
}

function glyphsFor(plain: boolean): LiveGlyphs {
  if (plain) {
    return {
      turn: "*",
      done: "+",
      compact: "#",
      subagent: ">",
      tree: "+--",
      reasoning: "~",
      awaiting: "...",
    };
  }
  return {
    turn: "●",
    done: "●",
    compact: "◆",
    subagent: "◇",
    tree: "└─",
    reasoning: "·",
    awaiting: "…",
  };
}

function toolIcon(name: string, plain: boolean): string {
  if (plain) {
    const map: Record<string, string> = {
      read: "[R]",
      write: "[W]",
      edit: "[E]",
      exec: "[$]",
      glob: "[G]",
      web_search: "[S]",
      web_fetch: "[U]",
      memory_search: "[M]",
      memory_get: "[m]",
      message: "[@]",
      sessions_spawn: "[A]",
    };
    return map[name] ?? "[?]";
  }
  return getToolIcon(name);
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

function fmtDuration(ms: number | undefined): string {
  if (ms == null || ms < 0) return "";
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

// ── Event renderer ─────────────────────────────────────────────────────────────

interface RenderOpts {
  W: number;
  density: LiveDensity;
  plain: boolean;
  color: boolean;
  glyphs: LiveGlyphs;
}

function renderEvent(event: LiveEvent, o: RenderOpts): string | null {
  const time = fmtTime(event.timestamp);
  const pad = " ".repeat(time.length);
  const dim = (s: string) => (o.color ? chalk.dim(s) : s);
  const bold = (s: string) => (o.color ? chalk.bold(s) : s);
  const cyan = (s: string) => (o.color ? chalk.cyan(s) : s);
  const green = (s: string) => (o.color ? chalk.green(s) : s);
  const red = (s: string) => (o.color ? chalk.red(s) : s);
  const yellow = (s: string) => (o.color ? chalk.yellow(s) : s);
  const magenta = (s: string) => (o.color ? chalk.magenta(s) : s);

  switch (event.kind) {
    case "session_meta": {
      const parts: string[] = [];
      if (event.model) parts.push(`model ${event.model}`);
      if (event.thinkingLevel)
        parts.push(`thinking ${event.thinkingLevel}`);
      if (parts.length === 0) return null;
      return dim(`  ${time}  ${o.glyphs.compact}  ${parts.join("  ·  ")}`);
    }

    case "turn_start": {
      const lines: string[] = [];
      const head =
        o.density === "compact"
          ? `\n${bold(`  ${time}  ${o.glyphs.turn} T${event.turnIndex ?? "?"}`)}`
          : `\n${bold(
              `  ${time}  ${o.glyphs.turn} Turn ${event.turnIndex ?? "?"}`
            )}`;
      lines.push(head);
      if (
        o.density !== "compact" &&
        event.userPreview &&
        event.userPreview.length > 0
      ) {
        const maxU = Math.max(24, o.W - 8);
        lines.push(dim(`  ${pad}  ${event.userPreview.slice(0, maxU)}`));
      }
      return lines.join("\n");
    }

    case "thinking": {
      if (event.thinkingContent) {
        const maxLen = Math.max(20, o.W - 18);
        const snippet = event.thinkingContent.slice(0, maxLen);
        const prefix = o.plain ? `${o.glyphs.reasoning} ` : "· ";
        return dim(`  ${time}  ${prefix}${snippet}`);
      }
      if (event.pendingKind === "reasoning_pending") {
        return dim(
          `  ${pad}  ${o.glyphs.awaiting}  reasoning (pending)…`
        );
      }
      if (event.pendingKind === "awaiting") {
        return dim(
          `  ${pad}  ${o.glyphs.awaiting}  waiting for assistant…`
        );
      }
      return dim(`  ${pad}  ${o.glyphs.awaiting}  waiting…`);
    }

    case "tool_call": {
      const icon = toolIcon(event.tool ?? "", o.plain);
      const nameRaw = event.tool ?? "unknown";
      const PAD = 16;
      const namePadded =
        nameRaw + " ".repeat(Math.max(0, PAD - nameRaw.length));
      const name = cyan(namePadded);
      const maxSummaryLen = Math.max(15, o.W - (10 + PAD + 8));
      const summary = event.toolSummary
        ? dim(event.toolSummary.slice(0, maxSummaryLen))
        : "";
      const idSuffix =
        o.density === "verbose" && event.toolCallId
          ? dim(`  ${event.toolCallId}`)
          : "";
      return `  ${time}  ${icon} ${name}${summary}${idSuffix}`;
    }

    case "tool_result": {
      if (event.toolError) {
        const dur = fmtDuration(event.durationMs);
        const durPart = dur ? `  ${dur}` : "";
        const ex =
          event.exitCode != null ? `  exit ${event.exitCode}` : "";
        return red(`  ${pad}  ${o.glyphs.tree} error${durPart}${ex}`);
      }
      if (o.density === "compact") return null;
      const dur = fmtDuration(event.durationMs);
      const durPart = dur ? dim(`  ${dur}`) : "";
      const ex =
        event.exitCode != null ? dim(`  exit ${event.exitCode}`) : "";
      const ok = o.color ? chalk.greenBright("ok") : "ok";
      let line = `  ${pad}  ${o.glyphs.tree} ${ok}${durPart}${ex}`;
      if (o.density === "verbose" && event.resultPreview) {
        const maxR = Math.max(20, o.W - 12);
        line += `\n  ${pad}      ${dim(event.resultPreview.slice(0, maxR))}`;
      }
      return line;
    }

    case "turn_end": {
      const toks = event.tokensOut
        ? dim(`  +${fmtTokens(event.tokensOut)} tok`)
        : "";
      const sr =
        o.density === "verbose" && event.stopReason
          ? dim(`  ${event.stopReason}`)
          : "";
      return green(`  ${time}  ${o.glyphs.done} done${toks}${sr}`);
    }

    case "compaction":
      return yellow(
        `  ${time}  ${o.glyphs.compact} compact  (context summarized)`
      );

    case "subagent_start": {
      const summary = event.toolSummary
        ? dim(
            `  ${event.toolSummary.slice(0, Math.max(15, o.W - 40))}`
          )
        : "";
      return magenta(
        `  ${time}  ${o.glyphs.subagent} subagent${summary}`
      );
    }

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
  W: number,
  color: boolean
): void {
  const hr = color ? chalk.dim("─".repeat(W)) : "─".repeat(W);
  const maxKeyLen = W - 14;
  const shortKey =
    sessionKey.length > maxKeyLen
      ? sessionKey.slice(0, maxKeyLen - 3) + "…"
      : sessionKey;
  const fileName = path.basename(jsonlPath);
  const b = (s: string) => (color ? chalk.bold(s) : s);
  const d = (s: string) => (color ? chalk.dim(s) : s);

  console.log(hr);
  console.log(`  ${b("Session:")} ${d(shortKey)}`);
  console.log(d(`  file: ${fileName}`));
  console.log(hr);
}

// ── Main command ─────────────────────────────────────────────────────────────

export async function runLive(
  cfg: ResolvedConfig,
  opts: LiveOptions
): Promise<void> {
  const W = process.stdout.columns || 80;
  const color =
    !!opts.plain ? false : !process.env["NO_COLOR"] && process.stdout.isTTY;
  let density: LiveDensity = opts.density ?? "normal";
  const plain = !!opts.plain;

  const hr = color ? chalk.dim("─".repeat(W)) : "─".repeat(W);

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

  const titleText =
    "clawprobe live  (+/- density · h help · q quit)";
  const titlePad = Math.max(0, W - titleText.length - nowStr.length);
  const title =
    (color ? chalk.bold("clawprobe live") : "clawprobe live") +
    (color
      ? chalk.dim("  (+/- density · h help · q quit)")
      : "  (+/- density · h help · q quit)") +
    " ".repeat(titlePad) +
    (color ? chalk.dim(nowStr) : nowStr);
  console.log(title);
  console.log(hr);
  console.log();

  let jsonlPath: string | null = null;

  if (opts.file) {
    if (!fs.existsSync(opts.file)) {
      console.error(color ? chalk.red(`Error: file not found: ${opts.file}`) : `Error: file not found: ${opts.file}`);
      process.exit(1);
    }
    jsonlPath = opts.file;
  } else {
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
      color
        ? chalk.dim(
            "  No active session found.\n" +
              "  Start OpenClaw, send a message, then run clawprobe live again."
          )
        : "  No active session found.\n  Start OpenClaw, send a message, then run clawprobe live again."
    );
    return;
  }

  const sessionEntry = getActiveSession(cfg.sessionsDir);
  const displayKey =
    sessionEntry?.sessionKey ?? path.basename(jsonlPath, ".jsonl");

  printSessionHeader(displayKey, jsonlPath, W, color);

  if (opts.history) {
    console.log(
      color ? chalk.dim("  (replaying history…)\n") : "  (replaying history…)\n"
    );
  } else {
    console.log(
      color
        ? chalk.dim(
            "  Watching for new events. Claude Code–style timeline: tools show results; thinking only when enabled.\n"
          )
        : "  Watching for new events.\n"
    );
  }

  const controller = new AbortController();

  function quit() {
    controller.abort();
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
      } catch { /* ignore */ }
    }
    process.stdin.pause();
    console.log("\n" + (color ? chalk.dim("  stopped.") : "  stopped."));
    process.exit(0);
  }

  function cycleDensity(dir: 1 | -1) {
    const order: LiveDensity[] = ["compact", "normal", "verbose"];
    const i = order.indexOf(density);
    const next = (i + dir + order.length) % order.length;
    density = order[next]!;
    const label = color
      ? chalk.dim(`  [density: ${density}]`)
      : `  [density: ${density}]`;
    console.log(label);
  }

  function printHelp() {
    const lines = [
      "  h, ?   this help",
      "  +      more verbose (compact → normal → verbose)",
      "  -      less verbose",
      "  q      quit",
    ];
    for (const L of lines) {
      console.log(color ? chalk.dim(L) : L);
    }
  }

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (key: string) => {
      if (key === "q" || key === "\u0003") quit();
      if (key === "+" || key === "=") cycleDensity(1);
      if (key === "-" || key === "_") cycleDensity(-1);
      if (key === "h" || key === "?" || key === "H") printHelp();
    });
  }

  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);

  await startLiveStream(
    jsonlPath,
    (event: LiveEvent) => {
      const glyphs = glyphsFor(plain);
      const line = renderEvent(event, {
        W,
        density,
        plain,
        color,
        glyphs,
      });
      if (line !== null) {
        console.log(line);
      }
    },
    controller.signal,
    !opts.history
  );
}
