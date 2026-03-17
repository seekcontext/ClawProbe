import { ResolvedConfig } from "../../core/config.js";
import { openDb, getAllSessionKeys } from "../../core/db.js";
import { getActiveSession, readSessionsStore } from "../../core/session-store.js";
import { getSessionCost, getAllSessionCosts, estimateCost, sessionCostFromEntry } from "../../engines/cost.js";
import chalk from "chalk";
import {
  header, fmtUsd, fmtTokens, fmtDate, fmtDuration, makeTable, outputJson,
  severity, roleIcon, divider,
} from "../format.js";

interface SessionOptions {
  agent?: string;
  list?: boolean;
  turns?: boolean;
  json?: boolean;
  full?: boolean;
}

export async function runSession(
  cfg: ResolvedConfig,
  sessionKeyArg: string | undefined,
  opts: SessionOptions
): Promise<void> {
  const agent = opts.agent ?? cfg.probe.openclaw.agent;
  const db = openDb(cfg.probeDir);
  const customPrices = cfg.probe.cost.customPrices;

  if (opts.list) {
    // Start with db-backed costs, then merge in any sessions.json entries not yet in db.
    const dbCosts = getAllSessionCosts(db, agent, customPrices);
    const dbKeys = new Set(dbCosts.map((c) => c.sessionKey));
    const liveEntries = readSessionsStore(cfg.sessionsDir)
      .filter((e) => !dbKeys.has(e.sessionKey))
      .map((e) => sessionCostFromEntry(e, customPrices));
    const costs = [...dbCosts, ...liveEntries].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
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
      // Full-width output: one session per line, no table truncation
      for (const c of costs) {
        const isActive = active?.sessionKey === c.sessionKey;
        const activeTag = isActive ? chalk.green(" ●") : "";
        console.log(`  ${chalk.bold(c.sessionKey)}${activeTag}`);
        console.log(`    Model: ${c.model ?? "—"}   In: ${fmtTokens(c.inputTokens)}   Out: ${fmtTokens(c.outputTokens)}   Compacts: ${c.compactionCount}   Last: ${c.lastActiveAt > 0 ? fmtDate(c.lastActiveAt) : "—"}`);
        console.log();
      }
    } else {
      const table = makeTable(
        ["Session Key", "Model", "Tokens (in/out)", "Cost", "Compacts", "Last Active"],
        [30, 22, 18, 10, 10, 16]
      );
      for (const c of costs) {
        const isActive = active?.sessionKey === c.sessionKey;
        // Show first 24 chars + ellipsis for readability; use --full for complete key
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

  // Single session view
  let targetKey = sessionKeyArg;
  if (!targetKey) {
    const active = getActiveSession(cfg.sessionsDir);
    if (!active) {
      console.error(severity.critical("No active session found. Pass a session key or ensure OpenClaw is running."));
      process.exit(1);
    }
    targetKey = active.sessionKey;
  }

  // Try db snapshots first; fall back to live sessions.json entry.
  let cost = getSessionCost(db, agent, targetKey, customPrices);
  if (!cost) {
    const liveEntry = readSessionsStore(cfg.sessionsDir).find((e) => e.sessionKey === targetKey);
    if (liveEntry) {
      cost = sessionCostFromEntry(liveEntry, customPrices);
    }
  }
  if (!cost) {
    console.error(severity.critical(`No data found for session: ${targetKey}`));
    console.log(severity.muted("  Start the daemon with: clawprobe start"));
    process.exit(1);
  }

  if (opts.json) {
    outputJson(cost);
    return;
  }

  header("📊", `Session: ${targetKey}`);

  console.log(`  Agent:       ${agent}`);
  if (cost.model) console.log(`  Model:       ${cost.model}`);
  if (cost.startedAt > 0) {
    console.log(`  Started:     ${fmtDate(cost.startedAt)}`);
    console.log(`  Last active: ${fmtDate(cost.lastActiveAt)}  (${fmtDuration(cost.durationMin)})`);
  }
  console.log(`  Compactions: ${cost.compactionCount}`);

  if (!cost.costAccurate) {
    if (cost.turns.length === 0) {
      console.log(severity.warning("  ⚠ Showing live data from sessions.json (daemon not running — no per-turn breakdown)"));
    } else {
      console.log(severity.muted("  ⚠ Cost may be understated (clawprobe was not running at session start)"));
    }
  }

  console.log();
  console.log(severity.bold("  Token usage:"));
  console.log(`    Input:   ${fmtTokens(cost.inputTokens)} tokens    ${fmtUsd(estimateCost({ input: cost.inputTokens, output: 0 }, cost.model, customPrices))}`);
  console.log(`    Output:  ${fmtTokens(cost.outputTokens)} tokens    ${fmtUsd(estimateCost({ input: 0, output: cost.outputTokens }, cost.model, customPrices))}`);
  console.log(`    Total:   ${fmtTokens(cost.totalTokens)} tokens    ${fmtUsd(cost.estimatedUsd)}`);

  const showTurns = opts.turns !== false && cost.turns.length > 0;
  if (showTurns) {
    console.log();
    console.log(severity.bold("  Turn-by-turn timeline:"));
    console.log();

    const maxUsd = Math.max(...cost.turns.map((t) => t.estimatedUsd), 0.001);

    for (const turn of cost.turns) {
      const compact = turn.compactOccurred ? severity.warning("← compact") : "";
      const usdStr = turn.estimatedUsd > 0 ? fmtUsd(turn.estimatedUsd) : severity.muted("$0.00");
      console.log(
        `    Turn ${String(turn.turnIndex).padStart(2)}  ${fmtDate(turn.timestamp)}` +
        `   +${fmtTokens(turn.inputTokensDelta)} in / +${fmtTokens(turn.outputTokensDelta)} out` +
        `   ${usdStr}  ${compact}`
      );
    }

    const avgUsd = cost.turns.reduce((s, t) => s + t.estimatedUsd, 0) / cost.turns.length;
    const maxTurn = cost.turns.reduce((max, t) => t.estimatedUsd > max.estimatedUsd ? t : max, cost.turns[0]!);
    console.log();
    console.log(severity.muted(`    Avg per turn: ${fmtUsd(avgUsd)}  |  Costliest: Turn ${maxTurn.turnIndex} (${fmtUsd(maxTurn.estimatedUsd)})`));
  }

  console.log();
}
