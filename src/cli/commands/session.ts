import path from "path";
import fs from "fs";
import { ResolvedConfig } from "../../core/config.js";
import { openDb } from "../../core/db.js";
import { getActiveSession, readSessionsStore, listJsonlFiles, sessionKeyFromPath, findJsonlPath } from "../../core/session-store.js";
import { parseSessionStats } from "../../core/jsonl-parser.js";
import {
  getSessionCostFromJsonl, estimateCost, sessionCostFromEntry,
  type SessionCost,
} from "../../engines/cost.js";
import chalk from "chalk";
import {
  header, fmtUsd, fmtTokens, fmtDate, fmtDuration, makeTable, outputJson,
  severity,
} from "../format.js";

interface SessionOptions {
  agent?: string;
  list?: boolean;
  turns?: boolean;
  json?: boolean;
  full?: boolean;
}

/**
 * Load session cost from the jsonl transcript — the authoritative source.
 * Falls back to sessions.json summary if no transcript is found.
 */
function loadSessionCost(
  sessionsDir: string,
  sessionKey: string,
  customPrices: Record<string, { input: number; output: number }>
): SessionCost | null {
  // First find the sessions.json entry so we can resolve the transcript path via UUID
  const liveEntry = readSessionsStore(sessionsDir).find((e) => e.sessionKey === sessionKey);

  // Resolve transcript path: OpenClaw names files by session UUID, not the human-readable key
  const jsonlPath = liveEntry
    ? findJsonlPath(sessionsDir, liveEntry)
    : (() => {
        // No sessions.json entry — try treating sessionKey as UUID filename directly
        const p = path.join(sessionsDir, `${sessionKey}.jsonl`);
        return fs.existsSync(p) ? p : null;
      })();

  if (jsonlPath) {
    const stats = parseSessionStats(jsonlPath);
    if (stats) {
      return getSessionCostFromJsonl(stats, sessionKey, customPrices);
    }
  }

  // Fall back to sessions.json summary
  if (liveEntry) {
    return sessionCostFromEntry(liveEntry, customPrices);
  }

  return null;
}

/**
 * Discover all sessions by reading sessions.json entries and resolving each
 * to its .jsonl transcript (identified by session UUID filename).
 */
function discoverAllSessions(
  sessionsDir: string,
  customPrices: Record<string, { input: number; output: number }>
): SessionCost[] {
  const costs: SessionCost[] = [];
  const seenJsonlPaths = new Set<string>();

  // Primary: sessions.json entries (human-readable keys), each resolved to its jsonl
  for (const entry of readSessionsStore(sessionsDir)) {
    const jsonlPath = findJsonlPath(sessionsDir, entry);
    if (jsonlPath) {
      seenJsonlPaths.add(jsonlPath);
      const stats = parseSessionStats(jsonlPath);
      if (stats) {
        costs.push(getSessionCostFromJsonl(stats, entry.sessionKey, customPrices));
        continue;
      }
    }
    // No transcript found — use sessions.json summary
    costs.push(sessionCostFromEntry(entry, customPrices));
  }

  // Supplement: any .jsonl files not covered by sessions.json (orphaned transcripts)
  for (const jsonlPath of listJsonlFiles(sessionsDir)) {
    if (seenJsonlPaths.has(jsonlPath)) continue;
    const key = sessionKeyFromPath(jsonlPath); // UUID as key
    const stats = parseSessionStats(jsonlPath);
    if (stats) {
      costs.push(getSessionCostFromJsonl(stats, key, customPrices));
    }
  }

  return costs.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
}

export async function runSession(
  cfg: ResolvedConfig,
  sessionKeyArg: string | undefined,
  opts: SessionOptions
): Promise<void> {
  const agent = opts.agent ?? cfg.probe.openclaw.agent;
  const customPrices = cfg.probe.cost.customPrices;

  if (opts.list) {
    const costs = discoverAllSessions(cfg.sessionsDir, customPrices);
    const active = getActiveSession(cfg.sessionsDir);

    if (opts.json) {
      outputJson(costs);
      return;
    }

    header("📋", "Sessions", `agent: ${agent}`);

    if (costs.length === 0) {
      console.log(severity.muted("  No sessions recorded yet."));
      console.log();
      return;
    }

    if (opts.full) {
      for (const c of costs) {
        const isActive = active?.sessionKey === c.sessionKey;
        const activeTag = isActive ? chalk.green(" ●") : "";
        console.log(`  ${chalk.bold(c.sessionKey)}${activeTag}`);
        console.log(
          `    Model: ${c.model ?? "—"}   ` +
          `In: ${fmtTokens(c.inputTokens)}   Out: ${fmtTokens(c.outputTokens)}   ` +
          `Compacts: ${c.compactionCount}   ` +
          `Last: ${c.lastActiveAt > 0 ? fmtDate(c.lastActiveAt) : "—"}`
        );
        console.log();
      }
    } else {
      const table = makeTable(
        ["Session Key", "Model", "Tokens (in/out)", "Cost", "Compacts", "Last Active"],
        [30, 22, 18, 10, 10, 16]
      );
      for (const c of costs) {
        const isActive = active?.sessionKey === c.sessionKey;
        const keyDisplay = c.sessionKey.length > 25
          ? `${c.sessionKey.slice(0, 24)}…${isActive ? " ●" : ""}`
          : `${c.sessionKey}${isActive ? " ●" : ""}`;
        table.push([
          keyDisplay,
          c.model ?? "—",
          `${fmtTokens(c.inputTokens)} / ${fmtTokens(c.outputTokens)}`,
          c.estimatedUsd > 0 ? fmtUsd(c.estimatedUsd) : "—",
          String(c.compactionCount),
          c.lastActiveAt > 0 ? fmtDate(c.lastActiveAt) : "—",
        ]);
      }
      console.log(table.toString());
      if (costs.some(c => c.sessionKey.length > 25)) {
        console.log(severity.muted("  Tip: use --full to see complete session keys"));
      }
    }
    console.log();
    return;
  }

  // ── Single session view ───────────────────────────────────────────────────
  let targetKey = sessionKeyArg;
  if (!targetKey) {
    const active = getActiveSession(cfg.sessionsDir);
    if (!active) {
      console.error(severity.critical("No active session found. Pass a session key or ensure OpenClaw is running."));
      process.exit(1);
    }
    targetKey = active.sessionKey;
  }

  const cost = loadSessionCost(cfg.sessionsDir, targetKey, customPrices);
  if (!cost) {
    console.error(severity.critical(`No data found for session: ${targetKey}`));
    console.log(severity.muted("  Ensure OpenClaw is running and has written a transcript."));
    process.exit(1);
  }

  if (opts.json) {
    outputJson(cost);
    return;
  }

  header("📊", `Session: ${targetKey}`);

  console.log(`  Agent:       ${agent}`);
  if (cost.model) console.log(`  Model:       ${cost.model}`);
  if (cost.provider) console.log(`  Provider:    ${cost.provider}`);
  if (cost.startedAt > 0) {
    console.log(`  Started:     ${fmtDate(cost.startedAt)}`);
    console.log(`  Last active: ${fmtDate(cost.lastActiveAt)}  (${fmtDuration(cost.durationMin)})`);
  }
  console.log(`  Compactions: ${cost.compactionCount}`);

  if (!cost.costAccurate) {
    console.log(severity.warning("  ⚠ Showing summary from sessions.json (no transcript found — no per-turn breakdown)"));
  }

  console.log();
  console.log(severity.bold("  Token usage:"));
  // inputTokens here = last turn's totalTokens (current context size)
  // outputTokens = cumulative output across all turns
  console.log(`    Context now: ${fmtTokens(cost.inputTokens)} tokens`);
  console.log(`    Output total: ${fmtTokens(cost.outputTokens)} tokens    ${fmtUsd(estimateCost({ input: 0, output: cost.outputTokens }, cost.model, customPrices))}`);

  const showTurns = opts.turns !== false && cost.turns.length > 0;
  if (showTurns) {
    console.log();
    console.log(severity.bold("  Turn-by-turn timeline:"));
    console.log();

    for (const turn of cost.turns) {
      const compact = turn.compactOccurred ? severity.warning("← compact") : "";
      const usdStr = turn.estimatedUsd > 0 ? fmtUsd(turn.estimatedUsd) : severity.muted("$0.00");
      console.log(
        `    Turn ${String(turn.turnIndex).padStart(2)}  ${fmtDate(turn.timestamp)}` +
        `   ctx ${fmtTokens(turn.inputTokensDelta)} / out +${fmtTokens(turn.outputTokensDelta)}` +
        `   ${usdStr}  ${compact}`
      );
    }

    const avgUsd = cost.turns.reduce((s, t) => s + t.estimatedUsd, 0) / cost.turns.length;
    const maxTurn = cost.turns.reduce(
      (max, t) => t.estimatedUsd > max.estimatedUsd ? t : max,
      cost.turns[0]!
    );
    console.log();
    console.log(severity.muted(
      `    Avg per turn: ${fmtUsd(avgUsd)}  |  Costliest: Turn ${maxTurn.turnIndex} (${fmtUsd(maxTurn.estimatedUsd)})`
    ));
  }

  console.log();
}
