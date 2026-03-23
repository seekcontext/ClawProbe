import path from "path";
import fs from "fs";
import { ResolvedConfig } from "../../core/config.js";
import { getActiveSession, readSessionsStore, listJsonlFiles, sessionKeyFromPath, findJsonlPath } from "../../core/session-store.js";
import { parseSessionStats, type ToolStat, type TodoItem, type AgentStat } from "../../core/jsonl-parser.js";
import { openDb, getToolStats, getTodoSnapshot, getAgentStats } from "../../core/db.js";
import {
  getSessionCostFromJsonl, estimateCost, sessionCostFromEntry,
  type SessionCost,
} from "../../engines/cost.js";
import chalk from "chalk";
import {
  header, fmtUsd, fmtTokens, fmtDate, fmtDuration, makeTable, computeColWidths, outputJson,
  outputJsonError, severity, printCostDisclaimer,
} from "../format.js";

interface SessionOptions {
  agent?: string;
  list?: boolean;
  turns?: boolean;
  todos?: boolean;
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
      const cost = getSessionCostFromJsonl(stats, key, customPrices);
      cost.isOrphan = true;
      costs.push(cost);
    }
  }

  return costs.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
}

function renderToolStats(toolStats: ToolStat[]): void {
  if (toolStats.length === 0) return;
  console.log();
  console.log(severity.bold("  Tool usage:"));
  console.log();
  for (const tool of toolStats) {
    const errStr = tool.errorCount > 0
      ? severity.warning(`  ${tool.errorCount} err`)
      : "";
    console.log(
      `    ${tool.name.padEnd(24)} ${String(tool.callCount).padStart(4)} call${tool.callCount !== 1 ? "s" : ""}${errStr}`
    );
  }
}

function renderTodos(todos: TodoItem[]): void {
  if (todos.length === 0) return;
  console.log();
  console.log(severity.bold("  Todo list:"));
  console.log();
  for (const todo of todos) {
    let icon: string;
    let label: string;
    if (todo.status === "completed") {
      icon = chalk.green("✓");
      label = chalk.dim(todo.content);
    } else if (todo.status === "in_progress") {
      icon = chalk.yellow("→");
      label = todo.content;
    } else {
      icon = chalk.dim("○");
      label = chalk.dim(todo.content);
    }
    console.log(`    ${icon}  ${label}`);
  }
  const done = todos.filter(t => t.status === "completed").length;
  const inprog = todos.filter(t => t.status === "in_progress").length;
  console.log();
  console.log(severity.muted(`    ${done}/${todos.length} completed${inprog > 0 ? `, ${inprog} in progress` : ""}`));
}

function renderAgentStats(agents: AgentStat[]): void {
  if (agents.length === 0) return;
  console.log();
  console.log(severity.bold(`  Sub-agents (${agents.length}):`));
  console.log();
  for (const a of agents) {
    const modelStr = a.model ? chalk.dim(` [${a.model}]`) : "";
    const descStr  = a.description ? ` — ${a.description.slice(0, 60)}` : "";
    console.log(`    ${a.type}${modelStr}${descStr}`);
  }
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

    const namedSessions = costs.filter(c => !c.isOrphan);
    const orphanSessions = costs.filter(c => c.isOrphan);

    if (opts.full) {
      for (const c of namedSessions) {
        const isActive = active?.sessionKey === c.sessionKey;
        const activeTag = isActive ? chalk.green(" ●") : "";
        const nameStr = c.sessionName ? ` ${chalk.dim(`"${c.sessionName}"`)}` : "";
        console.log(`  ${chalk.bold(c.sessionKey)}${activeTag}${nameStr}`);
        console.log(
          `    Model: ${c.model ?? "—"}   ` +
          `Ctx: ${fmtTokens(c.contextTokens || c.inputTokens)}   Out: ${fmtTokens(c.outputTokens)}   ` +
          `Compacts: ${c.compactionCount}   ` +
          `Last: ${c.lastActiveAt > 0 ? fmtDate(c.lastActiveAt) : "—"}`
        );
        console.log();
      }
      if (orphanSessions.length > 0) {
        console.log(severity.muted(`  ── Archived (${orphanSessions.length} sessions without a sessions.json entry) ──`));
        console.log();
        for (const c of orphanSessions) {
          console.log(`  ${severity.muted(c.sessionKey)}`);
          console.log(
            severity.muted(
              `    Model: ${c.model ?? "—"}   ` +
              `Ctx: ${fmtTokens(c.contextTokens || c.inputTokens)}   Out: ${fmtTokens(c.outputTokens)}   ` +
              `Last: ${c.lastActiveAt > 0 ? fmtDate(c.lastActiveAt) : "—"}`
            )
          );
          console.log();
        }
      }
    } else {
      const head = ["Session", "Model", "Ctx / Out tokens", "Cost", "Compacts", "Last Active"];
      const rows = namedSessions.map((c) => {
        const isActive = active?.sessionKey === c.sessionKey;
        // Prefer human-readable name; fall back to key
        const displayLabel = c.sessionName ?? c.sessionKey;
        const truncLimit = 28;
        const keyDisplay = displayLabel.length > truncLimit
          ? `${displayLabel.slice(0, truncLimit - 1)}…${isActive ? " ●" : ""}`
          : `${displayLabel}${isActive ? " ●" : ""}`;
        const ctxTokens = c.contextTokens || c.inputTokens;
        return [
          keyDisplay,
          c.model ?? "—",
          `${fmtTokens(ctxTokens)} / ${fmtTokens(c.outputTokens)}`,
          c.estimatedUsd > 0 ? fmtUsd(c.estimatedUsd) : "—",
          String(c.compactionCount),
          c.lastActiveAt > 0 ? fmtDate(c.lastActiveAt) : "—",
        ];
      });
      const colWidths = computeColWidths(head, rows, [24, 16, 14, 8, 8, 12]);
      const table = makeTable(head, colWidths);
      for (const row of rows) table.push(row);
      console.log(table.toString());
      if (namedSessions.some(c => !c.sessionName && c.sessionKey.length > 28)) {
        console.log(severity.muted("  Tip: use --full to see complete session keys"));
      }
      if (orphanSessions.length > 0) {
        console.log();
        console.log(severity.muted(`  + ${orphanSessions.length} archived session(s) without sessions.json entry (use --full to view)`));
      }
    }
    console.log();
    printCostDisclaimer();
    console.log();
    return;
  }

  // ── Single session view ───────────────────────────────────────────────────
  let targetKey = sessionKeyArg;
  if (!targetKey) {
    const active = getActiveSession(cfg.sessionsDir);
    if (!active) {
      if (opts.json) outputJsonError("no_active_session", "No active session found. Ensure OpenClaw is running.");
      console.error(severity.critical("No active session found. Pass a session key or ensure OpenClaw is running."));
      process.exit(1);
    }
    targetKey = active.sessionKey;
  }

  const cost = loadSessionCost(cfg.sessionsDir, targetKey, customPrices);
  if (!cost) {
    if (opts.json) outputJsonError("session_not_found", `No data found for session: ${targetKey}`);
    console.error(severity.critical(`No data found for session: ${targetKey}`));
    console.log(severity.muted("  Ensure OpenClaw is running and has written a transcript."));
    process.exit(1);
  }

  // Load supplementary data from DB (written by daemon)
  const db = openDb(cfg.probeDir);
  const dbToolStats  = getToolStats(db, agent, targetKey);
  const dbTodoSnap   = getTodoSnapshot(db, agent, targetKey);
  const dbAgentStats = getAgentStats(db, agent, targetKey);

  // Fall back to live-parsed stats if daemon hasn't run yet
  const liveEntry  = readSessionsStore(cfg.sessionsDir).find((e) => e.sessionKey === targetKey);
  const jsonlPath2 = liveEntry
    ? findJsonlPath(cfg.sessionsDir, liveEntry)
    : (() => {
        const p = path.join(cfg.sessionsDir, `${targetKey}.jsonl`);
        return fs.existsSync(p) ? p : null;
      })();
  const liveStats = jsonlPath2 ? parseSessionStats(jsonlPath2) : null;

  const toolStats: ToolStat[] = dbToolStats.length > 0
    ? dbToolStats.map(r => ({ name: r.tool_name, callCount: r.call_count, errorCount: r.error_count }))
    : (liveStats?.toolStats ?? []);
  const todos: TodoItem[]       = dbTodoSnap  ? JSON.parse(dbTodoSnap.todos_json) as TodoItem[] : (liveStats?.latestTodos ?? []);
  const agentList: AgentStat[]  = dbAgentStats.length > 0
    ? dbAgentStats.map(r => ({ id: r.sub_id, type: r.sub_type, model: r.model ?? undefined, description: r.description ?? undefined }))
    : (liveStats?.agentStats ?? []);

  if (opts.json) {
    outputJson({ ...cost, toolStats, todos, agents: agentList });
    return;
  }

  const sessionTitle = cost.sessionName ? `${cost.sessionName}  ${chalk.dim(`(${targetKey})`)}` : targetKey;
  header("📊", `Session: ${sessionTitle}`);

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
  if (cost.contextTokens > 0) {
    console.log(`    Context now:  ${fmtTokens(cost.contextTokens)} tokens  ${severity.muted("(current context window usage)")}`);
  } else if (cost.inputTokens > 0) {
    console.log(`    Context now:  ${fmtTokens(cost.inputTokens)} tokens  ${severity.muted("(last turn input)")}`);
  }
  console.log(`    Output total: ${fmtTokens(cost.outputTokens)} tokens    ${fmtUsd(cost.estimatedUsd)}`);

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

  // Tool usage, todos, sub-agents
  renderToolStats(toolStats);
  if (opts.todos !== false) {
    renderTodos(todos);
  }
  renderAgentStats(agentList);

  console.log();
  printCostDisclaimer();
  console.log();
}
