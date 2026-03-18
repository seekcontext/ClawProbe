import fs from "fs";
import { DatabaseSync } from "node:sqlite";
import { getCompactEvents, getSuggestions, upsertSuggestion, removeSuggestion, getTurnSummaryByDate } from "../core/db.js";
import { getWindowSize } from "../core/model-windows.js";
import { parseSessionStats } from "../core/jsonl-parser.js";
import { findJsonlPath, getActiveSession } from "../core/session-store.js";
import { analyzeWorkspaceFiles } from "./file-analyzer.js";
import { ProbeConfig } from "../core/config.js";

export interface Suggestion {
  ruleId: string;
  severity: "critical" | "warning" | "info";
  title: string;
  detail: string;
  action?: string;
}

export interface ProbeState {
  db: DatabaseSync;
  agent: string;
  workspaceDir: string;
  sessionsDir: string;
  bootstrapMaxChars: number;
  config: ProbeConfig;
}

export interface Rule {
  id: string;
  name: string;
  check(state: ProbeState): Suggestion | null;
}

// --- Built-in Rules ---

const ToolsMdTruncationRule: Rule = {
  id: "tools-truncation",
  name: "TOOLS.md Truncation",
  check({ workspaceDir, bootstrapMaxChars }) {
    const analysis = analyzeWorkspaceFiles(workspaceDir, bootstrapMaxChars);
    const toolsMd = analysis.truncatedFiles.find((f) => f.name === "TOOLS.md");
    if (!toolsMd) return null;

    const wastePct = Math.round(toolsMd.lostPercent);
    const wasteKb = Math.round(toolsMd.lostChars / 1024);

    return {
      ruleId: "tools-truncation",
      severity: "critical",
      title: `TOOLS.md truncated — ${wastePct}% never reaches the model`,
      detail:
        `${wasteKb}KB of tool descriptions are silently cut off because TOOLS.md ` +
        `exceeds the ${Math.round(bootstrapMaxChars / 1000)}K char bootstrap limit. ` +
        `The model cannot see or use tools defined in the truncated section.`,
      action:
        "Split TOOLS.md into per-task Skill files, or increase bootstrapMaxChars in openclaw.json",
    };
  },
};

const HighCompactionFrequencyRule: Rule = {
  id: "high-compact-freq",
  name: "High Compaction Frequency",
  check({ db, agent, config }) {
    const threshold = config.rules.compactionFreqThresholdMin * 60; // convert to seconds
    const events = getCompactEvents(db, agent, 10);
    if (events.length < 3) return null;

    const timestamps = events
      .filter((e) => e.compacted_at !== null)
      .map((e) => e.compacted_at!)
      .sort((a, b) => a - b);

    if (timestamps.length < 2) return null;

    const intervals: number[] = [];
    for (let i = 1; i < timestamps.length; i++) {
      intervals.push(timestamps[i]! - timestamps[i - 1]!);
    }

    const avgIntervalSec = intervals.reduce((s, v) => s + v, 0) / intervals.length;

    if (avgIntervalSec >= threshold) return null;

    const avgMin = Math.round(avgIntervalSec / 60);

    return {
      ruleId: "high-compact-freq",
      severity: "warning",
      title: `Compaction frequency too high (avg every ${avgMin} min)`,
      detail:
        `Your context compacts on average every ${avgMin} minutes. ` +
        `Frequent compaction means frequent context loss and recovery overhead. ` +
        `Consider increasing reserveTokens in openclaw.json to delay compaction.`,
      action: 'Set "compaction.reserveTokens" to a higher value in openclaw.json',
    };
  },
};

const ContextLeakRule: Rule = {
  id: "context-headroom",
  name: "Context Window Nearly Full",
  check({ db, agent, sessionsDir }) {
    const activeSession = getActiveSession(sessionsDir);
    if (!activeSession) return null;

    const transcriptPath = findJsonlPath(sessionsDir, activeSession);
    const jsonlStats = transcriptPath ? parseSessionStats(transcriptPath) : null;

    // Fall back to the snapshot only for model/provider metadata.
    const snapshot = (db.prepare(`
      SELECT * FROM session_snapshots
      WHERE agent = ? AND session_key = ?
      ORDER BY sampled_at DESC
      LIMIT 1
    `).get(agent, activeSession.sessionKey)) as import("../core/db.js").SessionSnapshotRow | undefined;

    const currentTokens = jsonlStats?.lastTotalTokens ?? activeSession.sessionTokens;
    if (currentTokens <= 0) return null;

    const configuredWindowSize = activeSession.windowSize || activeSession.contextTokens;
    const model = jsonlStats?.model ?? activeSession.modelOverride ?? snapshot?.model ?? null;
    const windowSize = getWindowSize(model, configuredWindowSize || currentTokens);
    const utilization = currentTokens / windowSize;

    if (utilization < 0.9) return null;

    return {
      ruleId: "context-headroom",
      severity: "warning",
      title: `Context window at ${Math.round(utilization * 100)}% capacity`,
      detail:
        `Current context is ${currentTokens.toLocaleString()} tokens ` +
        `out of ~${windowSize.toLocaleString()} (${Math.round(utilization * 100)}%). ` +
        `Compaction may trigger soon, potentially losing important context.`,
      action: "Consider starting a fresh session or manually compacting now",
    };
  },
};

const CostSpikeRule: Rule = {
  id: "cost-spike",
  name: "Cost Spike Detected",
  check({ db, agent }) {
    const rawRows = getTurnSummaryByDate(db, agent, 8);
    // Collapse model-split rows into one entry per date
    const byDate = new Map<string, number>();
    for (const r of rawRows) {
      byDate.set(r.date, (byDate.get(r.date) ?? 0) + r.estimated_usd);
    }
    if (byDate.size < 3) return null;

    const today = new Date().toISOString().slice(0, 10);
    const todayUsd = byDate.get(today) ?? 0;
    if (todayUsd === 0) return null;

    const priorEntries = [...byDate.entries()].filter(([d]) => d !== today);
    const priorAvg = priorEntries.reduce((s, [, v]) => s + v, 0) / priorEntries.length;

    if (priorAvg === 0 || todayUsd < priorAvg * 2) return null;

    return {
      ruleId: "cost-spike",
      severity: "warning",
      title: `Today's cost is ${Math.round(todayUsd / priorAvg)}× the weekly average`,
      detail:
        `Today: $${todayUsd.toFixed(2)} vs weekly avg $${priorAvg.toFixed(2)}/day. ` +
        `Check if a long-running task, large file, or model change is driving up costs.`,
      action: "Run `clawprobe cost --day` and `clawprobe context` for details",
    };
  },
};

const MemoryBloatRule: Rule = {
  id: "memory-bloat",
  name: "MEMORY.md Too Large",
  check({ workspaceDir, config }) {
    const memPath = `${workspaceDir}/MEMORY.md`;
    let size = 0;
    if (fs.existsSync(memPath)) {
      size = fs.readFileSync(memPath, "utf-8").length;
    }
    const threshold = config.rules.memoryBloatThresholdChars;
    if (size < threshold) return null;

    return {
      ruleId: "memory-bloat",
      severity: "info",
      title: `MEMORY.md is large (${Math.round(size / 1024)}KB)`,
      detail:
        `MEMORY.md contains ${size.toLocaleString()} chars which consumes ~${Math.ceil(size / 4).toLocaleString()} tokens ` +
        `in every session's context. Consider archiving older entries to daily note files.`,
      action: "Run `clawprobe memory list` to review and prune entries",
    };
  },
};

// --- Engine ---

const BUILT_IN_RULES: Rule[] = [
  ToolsMdTruncationRule,
  HighCompactionFrequencyRule,
  ContextLeakRule,
  CostSpikeRule,
  MemoryBloatRule,
];

export function runRules(
  state: ProbeState,
  customRules: Rule[] = []
): Suggestion[] {
  const disabled = new Set(state.config.rules.disabled);
  const rules = [...BUILT_IN_RULES, ...customRules].filter(
    (r) => !disabled.has(r.id)
  );

  const results: Suggestion[] = [];
  for (const rule of rules) {
    try {
      const suggestion = rule.check(state);
      if (suggestion) results.push(suggestion);
    } catch {
      // rule threw — skip it
    }
  }

  return results;
}

export function persistSuggestions(
  db: DatabaseSync,
  agent: string,
  suggestions: Suggestion[]
): void {
  const now = Math.floor(Date.now() / 1000);
  const activeRuleIds = new Set(suggestions.map((s) => s.ruleId));

  // Remove suggestions for rules that no longer fire
  const existingSuggestions = getSuggestions(db, agent);
  for (const existing of existingSuggestions) {
    if (!activeRuleIds.has(existing.rule_id)) {
      removeSuggestion(db, agent, existing.rule_id);
    }
  }

  // Upsert active suggestions
  for (const s of suggestions) {
    upsertSuggestion(db, {
      agent,
      rule_id: s.ruleId,
      severity: s.severity,
      title: s.title,
      detail: s.detail,
      action: s.action ?? null,
      created_at: now,
    });
  }
}
