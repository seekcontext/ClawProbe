import fs from "fs";
import { DatabaseSync } from "node:sqlite";
import { getCompactEvents, getSuggestions, upsertSuggestion, removeSuggestion, getDailyCostSummary } from "../core/db.js";
import { analyzeWorkspaceFiles, getFileStaleness } from "./file-analyzer.js";
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
  check({ db, agent }) {
    // Find the most recent snapshot across all sessions
    const snapshot = (db.prepare(`
      SELECT * FROM session_snapshots
      WHERE agent = ?
      ORDER BY sampled_at DESC
      LIMIT 1
    `).get(agent)) as import("../core/db.js").SessionSnapshotRow | undefined;

    if (!snapshot) return null;

    const MODEL_WINDOWS: Record<string, number> = {
      "claude-opus-4": 200000,
      "claude-sonnet-4.5": 200000,
      "gpt-5.4": 128000,
      "gpt-5.4-mini": 128000,
      "gemini-3.1-flash": 1000000,
      "deepseek-v3": 128000,
    };

    const modelKey = Object.keys(MODEL_WINDOWS).find((k) =>
      snapshot.model?.includes(k)
    );
    const windowSize = modelKey ? MODEL_WINDOWS[modelKey]! : 128000;
    const utilization = snapshot.context_tokens / windowSize;

    if (utilization < 0.9) return null;

    return {
      ruleId: "context-headroom",
      severity: "warning",
      title: `Context window at ${Math.round(utilization * 100)}% capacity`,
      detail:
        `Current context is ${snapshot.context_tokens.toLocaleString()} tokens ` +
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
    const rows = getDailyCostSummary(db, agent, 8);
    if (rows.length < 3) return null;

    const today = new Date().toISOString().slice(0, 10);
    const todayRow = rows.find((r) => r.date === today);
    if (!todayRow || todayRow.total_usd === 0) return null;

    const priorRows = rows.filter((r) => r.date !== today);
    const priorAvg =
      priorRows.reduce((s, r) => s + r.total_usd, 0) / priorRows.length;

    if (priorAvg === 0 || todayRow.total_usd < priorAvg * 2) return null;

    return {
      ruleId: "cost-spike",
      severity: "warning",
      title: `Today's cost is ${Math.round(todayRow.total_usd / priorAvg)}× the weekly average`,
      detail:
        `Today: $${todayRow.total_usd.toFixed(2)} vs weekly avg $${priorAvg.toFixed(2)}/day. ` +
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

const StaleFilesRule: Rule = {
  id: "stale-workspace-files",
  name: "Stale Workspace Files",
  check({ workspaceDir }) {
    const stale = getFileStaleness(workspaceDir).filter(
      (f) => f.daysSinceModified > 30
    );
    if (stale.length < 2) return null;

    const names = stale.map((f) => f.name).join(", ");

    return {
      ruleId: "stale-workspace-files",
      severity: "info",
      title: `${stale.length} workspace files unchanged for 30+ days`,
      detail:
        `${names} haven't been modified in over a month but still consume ` +
        `context tokens in every session. They may be outdated or unnecessary.`,
      action: "Review and trim or archive files that are no longer relevant",
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
  StaleFilesRule,
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
