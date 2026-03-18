import { DatabaseSync } from "node:sqlite";
import {
  getTurnRows,
  upsertTurnRecord,
  getAllSessionKeys,
  getFirstSnapshot,
  getLatestSnapshot,
  getAllSnapshots,
} from "../core/db.js";
import type { SessionEntry } from "../core/session-store.js";
import type { SessionStats } from "../core/jsonl-parser.js";

export interface ModelPrice {
  /** Normal input token price (USD / 1M tokens) */
  input: number;
  /** Output token price (USD / 1M tokens) */
  output: number;
  /**
   * Cache-read multiplier relative to input price (default 0.1 = 10% of input).
   * Set to 0 if the provider does not charge for cache reads.
   */
  cacheReadMultiplier?: number;
  /**
   * Cache-write multiplier relative to input price (default 1.0 = same as input).
   * Some providers charge extra for writing to the prompt cache (e.g. Anthropic 1.25x).
   * Set to 0 if the provider does not charge for cache writes.
   */
  cacheWriteMultiplier?: number;
}

// USD per 1M tokens — prices as of March 2026
export const MODEL_PRICES: Record<string, ModelPrice> = {
  // Anthropic — https://www.anthropic.com/pricing
  // cache write: 1.25x input; cache read: 0.1x input
  "anthropic/claude-opus-4":         { input: 15.00, output: 75.00, cacheWriteMultiplier: 1.25, cacheReadMultiplier: 0.1 },
  "anthropic/claude-opus-4.6":       { input: 5.00,  output: 25.00, cacheWriteMultiplier: 1.25, cacheReadMultiplier: 0.1 },
  "anthropic/claude-sonnet-4.5":     { input: 3.00,  output: 15.00, cacheWriteMultiplier: 1.25, cacheReadMultiplier: 0.1 },
  "anthropic/claude-sonnet-4.6":     { input: 3.00,  output: 15.00, cacheWriteMultiplier: 1.25, cacheReadMultiplier: 0.1 },
  "anthropic/claude-haiku-3.5":      { input: 0.80,  output: 4.00,  cacheWriteMultiplier: 1.25, cacheReadMultiplier: 0.1 },
  "anthropic/claude-haiku-4.5":      { input: 1.00,  output: 5.00,  cacheWriteMultiplier: 1.25, cacheReadMultiplier: 0.1 },
  // OpenAI — https://platform.openai.com/docs/pricing
  // cache read: 0.5x input; no explicit cache write charge
  "openai/gpt-4o":                   { input: 2.50,  output: 10.00, cacheReadMultiplier: 0.5, cacheWriteMultiplier: 0 },
  "openai/gpt-4o-mini":              { input: 0.15,  output: 0.60,  cacheReadMultiplier: 0.5, cacheWriteMultiplier: 0 },
  "openai/o3":                       { input: 2.00,  output: 8.00,  cacheReadMultiplier: 0.5, cacheWriteMultiplier: 0 },
  "openai/gpt-5.4":                  { input: 5.00,  output: 20.00, cacheReadMultiplier: 0.5, cacheWriteMultiplier: 0 },
  "openai/gpt-5.4-mini":             { input: 0.30,  output: 1.20,  cacheReadMultiplier: 0.5, cacheWriteMultiplier: 0 },
  "openai/o4-mini":                  { input: 1.10,  output: 4.40,  cacheReadMultiplier: 0.5, cacheWriteMultiplier: 0 },
  // Google — https://ai.google.dev/gemini-api/docs/pricing
  // cache read: 0.25x input; cache write: 1x input (storage billed separately, not modeled here)
  "google/gemini-2.5-flash":         { input: 0.30,  output: 2.50,  cacheReadMultiplier: 0.25, cacheWriteMultiplier: 1.0 },
  "google/gemini-2.5-pro":           { input: 1.25,  output: 10.00, cacheReadMultiplier: 0.25, cacheWriteMultiplier: 1.0 },
  "google/gemini-3.1-flash":         { input: 0.075, output: 0.30,  cacheReadMultiplier: 0.25, cacheWriteMultiplier: 1.0 },
  "google/gemini-3.1-pro":           { input: 1.25,  output: 5.00,  cacheReadMultiplier: 0.25, cacheWriteMultiplier: 1.0 },
  // DeepSeek — https://api-docs.deepseek.com/quick_start/pricing
  // cache read (disk): 0.1x; cache read (memory): ~0.018x; using disk rate as conservative estimate
  "deepseek/deepseek-v3":            { input: 0.27,  output: 1.10,  cacheReadMultiplier: 0.1, cacheWriteMultiplier: 0 },
  "deepseek/deepseek-v3.2":          { input: 0.28,  output: 0.42,  cacheReadMultiplier: 0.1, cacheWriteMultiplier: 0 },
  "deepseek/deepseek-r1":            { input: 0.55,  output: 2.19,  cacheReadMultiplier: 0.1, cacheWriteMultiplier: 0 },
  "deepseek/deepseek-r2":            { input: 0.55,  output: 2.19,  cacheReadMultiplier: 0.1, cacheWriteMultiplier: 0 },
  // Mistral — https://mistral.ai/pricing/ (no prompt caching documented)
  "mistral/mistral-large":           { input: 0.50,  output: 1.50  },
  "mistral/mistral-small":           { input: 0.10,  output: 0.30  },
  // Moonshot (Kimi) — https://platform.moonshot.ai/docs/pricing
  // cache read: ~1/6 of input price (¥1/M vs ¥6/M for kimi-k2.5)
  "moonshot/kimi-k2":                { input: 0.40,  output: 2.00,  cacheReadMultiplier: 0.167, cacheWriteMultiplier: 0 },
  "moonshot/kimi-k2.5":              { input: 0.60,  output: 2.00,  cacheReadMultiplier: 0.167, cacheWriteMultiplier: 0 },
  // Alibaba (Qwen) — https://help.aliyun.com/zh/model-studio/getting-started/models
  "qwen/qwen3-max":                  { input: 0.34,  output: 1.38  },
  "qwen/qwen3.5-plus":               { input: 0.11,  output: 0.66  },
  "qwen/qwen3.5-flash":              { input: 0.065, output: 0.26  },
  "qwen/qwen-long":                  { input: 0.069, output: 0.276 },
  // Zhipu (GLM) — https://open.bigmodel.cn/pricing
  "zhipu/glm-4":                     { input: 0.14,  output: 0.14  },
  "zhipu/glm-4-plus":                { input: 0.69,  output: 0.69  },
  "zhipu/glm-4-32b":                 { input: 0.10,  output: 0.10  },
  // ByteDance (Doubao) — https://www.volcengine.com/product/ark/pricing
  "bytedance/doubao-pro-32k":        { input: 0.11,  output: 0.11  },
  "bytedance/doubao-1.5-pro-32k":    { input: 0.069, output: 0.069 },
};

export interface TokenCount {
  input: number;
  output: number;
  /** Tokens served from prompt cache (billed at a discounted rate) */
  cacheRead?: number;
  /** Tokens written to prompt cache (may be billed at a premium rate) */
  cacheWrite?: number;
}

export interface DailyCost {
  date: string;
  usd: number;
  inputTokens: number;
  outputTokens: number;
}

export interface PeriodCostSummary {
  period: string;
  startDate: string;
  endDate: string;
  totalUsd: number;
  inputTokens: number;
  outputTokens: number;
  dailyAvg: number;
  monthEstimate: number;
  daily: DailyCost[];
  model?: string;
  /** Model names found in DB that had no matching price entry */
  unpricedModels?: string[];
}

export interface SessionCost {
  sessionKey: string;
  model: string | null;
  provider: string | null;
  /** Cumulative input tokens sent (from sessions.json or db snapshots) */
  inputTokens: number;
  /** Cumulative output tokens received */
  outputTokens: number;
  totalTokens: number;
  /** Current context window occupancy (from jsonl usage.input of the last turn) */
  contextTokens: number;
  /** True if this session has no sessions.json entry — identified only by its jsonl UUID */
  isOrphan: boolean;
  estimatedUsd: number;
  startedAt: number;
  lastActiveAt: number;
  durationMin: number;
  compactionCount: number;
  costAccurate: boolean;
  turns: TurnCost[];
}

export interface TurnCost {
  turnIndex: number;
  timestamp: number;
  inputTokensDelta: number;
  outputTokensDelta: number;
  estimatedUsd: number;
  compactOccurred: boolean;
}

export function estimateCost(
  tokens: TokenCount,
  model: string | null,
  customPrices: Record<string, ModelPrice> = {}
): number {
  if (!model) return 0;

  const prices = { ...MODEL_PRICES, ...customPrices };

  // Try exact match first, then substring-match on the model slug after "/"
  const price =
    prices[model] ??
    Object.entries(prices).find(([key]) => model.includes(key.split("/")[1] ?? key))?.[1];

  if (!price) return 0;

  // Non-cached input = input minus any tokens already covered by cacheRead/cacheWrite
  const cacheRead  = tokens.cacheRead  ?? 0;
  const cacheWrite = tokens.cacheWrite ?? 0;
  const normalInput = Math.max(0, tokens.input - cacheRead - cacheWrite);

  const cacheReadRate  = price.cacheReadMultiplier  ?? 0;
  const cacheWriteRate = price.cacheWriteMultiplier ?? 0;

  return (normalInput  / 1_000_000) * price.input +
         (tokens.output / 1_000_000) * price.output +
         (cacheRead     / 1_000_000) * price.input * cacheReadRate +
         (cacheWrite    / 1_000_000) * price.input * cacheWriteRate;
}

export function getSessionCost(
  db: DatabaseSync,
  agent: string,
  sessionKey: string,
  customPrices: Record<string, { input: number; output: number }> = {}
): SessionCost | null {
  const snapshots = getAllSnapshots(db, agent, sessionKey);
  if (snapshots.length === 0) return null;

  const first = snapshots[0]!;
  const last = snapshots[snapshots.length - 1]!;
  const model = last.model ?? first.model;

  // Each snapshot stores *cumulative* token totals reported by the agent runtime.
  // The session's total consumption is simply the latest snapshot's absolute value.
  // We fall back to (last - first) deltas only for the turn-by-turn breakdown,
  // where consecutive snapshots represent incremental sampling points.
  const totalInput = last.input_tokens;
  const totalOutput = last.output_tokens;

  const turns: TurnCost[] = [];
  for (let i = 1; i < snapshots.length; i++) {
    const prev = snapshots[i - 1]!;
    const curr = snapshots[i]!;
    // Only count turns where tokens actually increased (skip re-snapshots with same values)
    const inDelta = Math.max(0, curr.input_tokens - prev.input_tokens);
    const outDelta = Math.max(0, curr.output_tokens - prev.output_tokens);
    if (inDelta === 0 && outDelta === 0) continue;
    const compactOccurred = curr.compaction_count > prev.compaction_count;

    turns.push({
      turnIndex: turns.length + 1,
      timestamp: curr.sampled_at,
      inputTokensDelta: inDelta,
      outputTokensDelta: outDelta,
      estimatedUsd: estimateCost({ input: inDelta, output: outDelta }, model, customPrices),
      compactOccurred,
    });
  }

  return {
    sessionKey,
    model,
    provider: last.provider ?? first.provider,
    inputTokens: totalInput,
    outputTokens: totalOutput,
    totalTokens: totalInput + totalOutput,
    contextTokens: 0,
    isOrphan: false,
    estimatedUsd: estimateCost({ input: totalInput, output: totalOutput }, model, customPrices),
    startedAt: first.sampled_at,
    lastActiveAt: last.sampled_at,
    durationMin: Math.round((last.sampled_at - first.sampled_at) / 60),
    compactionCount: last.compaction_count,
    costAccurate: true,
    turns,
  };
}

/**
 * Synthesise a SessionCost directly from a sessions.json entry (no db snapshots).
 * costAccurate is false because we only have the cumulative total, not per-turn deltas.
 */
export function sessionCostFromEntry(
  entry: SessionEntry,
  customPrices: Record<string, { input: number; output: number }> = {}
): SessionCost {
  const model = entry.modelOverride ?? null;
  const usd = estimateCost({ input: entry.inputTokens, output: entry.outputTokens }, model, customPrices);
  return {
    sessionKey: entry.sessionKey,
    model,
    provider: entry.providerOverride ?? null,
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens,
    totalTokens: entry.totalTokens,
    contextTokens: entry.sessionTokens ?? 0,
    isOrphan: false,
    estimatedUsd: usd,
    startedAt: entry.updatedAt,
    lastActiveAt: entry.updatedAt,
    durationMin: 0,
    compactionCount: entry.compactionCount,
    costAccurate: false,
    turns: [],
  };
}

/**
 * Build a SessionCost directly from parsed jsonl stats.
 * This is the most accurate data source — usage comes from the model's own reported token counts.
 */
export function getSessionCostFromJsonl(
  stats: SessionStats,
  sessionKey: string,
  customPrices: Record<string, { input: number; output: number }> = {}
): SessionCost {
  const model = stats.model;

  // Each turn's inputTokensDelta = that turn's usage.input (= full context sent that turn).
  // Each turn's outputTokensDelta = that turn's usage.output (incremental output).
  // Cache tokens are passed through so estimateCost can apply the correct discounted rate.
  const turns: TurnCost[] = stats.turns.map((t) => ({
    turnIndex: t.turnIndex,
    timestamp: t.timestamp,
    inputTokensDelta: t.usage.input,
    outputTokensDelta: t.usage.output,
    estimatedUsd: estimateCost(
      {
        input: t.usage.input,
        output: t.usage.output,
        cacheRead: t.usage.cacheRead,
        cacheWrite: t.usage.cacheWrite,
      },
      model,
      customPrices
    ),
    compactOccurred: false,
  }));

  // Total cost = sum of per-turn costs (each turn bills its own input context + output)
  const totalUsd = turns.reduce((s, t) => s + t.estimatedUsd, 0);

  return {
    sessionKey,
    model,
    provider: stats.provider,
    // totalInput = Σ(input per turn) — matches API billing: each turn charges its full context
    inputTokens: stats.totalInput,
    outputTokens: stats.totalOutput,
    totalTokens: stats.totalInput + stats.totalOutput,
    // contextTokens = current context window size (last turn's totalTokens, for display only)
    contextTokens: stats.lastTotalTokens,
    isOrphan: false,
    estimatedUsd: totalUsd,
    startedAt: stats.startedAt,
    lastActiveAt: stats.lastActiveAt,
    durationMin: Math.round((stats.lastActiveAt - stats.startedAt) / 60),
    compactionCount: stats.compactionCount,
    costAccurate: true,
    turns,
  };
}

export function getAllSessionCosts(
  db: DatabaseSync,
  agent: string,
  customPrices: Record<string, ModelPrice> = {}
): SessionCost[] {
  const keys = getAllSessionKeys(db, agent);
  return keys
    .map(({ session_key }) => getSessionCost(db, agent, session_key, customPrices))
    .filter((s): s is SessionCost => s !== null);
}

/**
 * Write every turn of a session into turn_records.
 * Called by the daemon each time a jsonl file is scanned.
 */
export function recordSessionTurns(
  db: DatabaseSync,
  agent: string,
  sessionKey: string,
  stats: SessionStats,
  customPrices: Record<string, ModelPrice> = {}
): void {
  for (const turn of stats.turns) {
    const turnDate = turn.timestamp > 0
      ? new Date(turn.timestamp * 1000).toISOString().slice(0, 10)
      : todayString();
    const usd = estimateCost(
      {
        input: turn.usage.input,
        output: turn.usage.output,
        cacheRead: turn.usage.cacheRead,
        cacheWrite: turn.usage.cacheWrite,
      },
      turn.model ?? stats.model,
      customPrices
    );
    upsertTurnRecord(db, {
      agent,
      session_key: sessionKey,
      date: turnDate,
      turn_index: turn.turnIndex,
      sampled_at: turn.timestamp > 0 ? turn.timestamp : Math.floor(Date.now() / 1000),
      model: turn.model ?? stats.model,
      provider: turn.provider ?? stats.provider,
      input_tokens: turn.usage.input,
      output_tokens: turn.usage.output,
      cache_read: turn.usage.cacheRead,
      cache_write: turn.usage.cacheWrite,
      estimated_usd: usd,
    });
  }
}

export function getPeriodCost(
  db: DatabaseSync,
  agent: string,
  period: "day" | "week" | "month" | "all",
  customPrices: Record<string, ModelPrice> = {}
): PeriodCostSummary {
  const now = new Date();
  const today = formatDate(now);

  let days: number;
  let startDate: string;
  let periodLabel: string;

  switch (period) {
    case "day":
      days = 1;
      startDate = today;
      periodLabel = `Today (${today})`;
      break;
    case "week":
      days = 7;
      startDate = formatDate(new Date(now.getTime() - 6 * 86400_000));
      periodLabel = `${startDate} – ${today}`;
      break;
    case "month":
      days = 30;
      startDate = formatDate(new Date(now.getTime() - 29 * 86400_000));
      periodLabel = `${startDate} – ${today}`;
      break;
    case "all":
      days = 3650;
      startDate = "2020-01-01";
      periodLabel = "All time";
      break;
  }

  // Read raw per-turn rows and recompute cost using the live price table.
  // Because we now store cache_read/cache_write per turn, the recomputed
  // value accurately reflects provider billing (including cache discounts).
  const rows = getTurnRows(db, agent, days);

  const byDate = new Map<string, {
    usd: number; input: number; output: number;
    cacheRead: number; cacheWrite: number; unpriced: string[];
  }>();

  for (const row of rows) {
    let entry = byDate.get(row.date);
    if (!entry) {
      entry = { usd: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unpriced: [] };
      byDate.set(row.date, entry);
    }
    entry.input     += row.input_tokens;
    entry.output    += row.output_tokens;
    entry.cacheRead += row.cache_read;
    entry.cacheWrite+= row.cache_write;

    if (row.model) {
      const recomputed = estimateCost(
        { input: row.input_tokens, output: row.output_tokens,
          cacheRead: row.cache_read, cacheWrite: row.cache_write },
        row.model,
        customPrices
      );
      if (recomputed > 0) {
        entry.usd += recomputed;
      } else {
        entry.usd += row.estimated_usd;
        if (!entry.unpriced.includes(row.model)) entry.unpriced.push(row.model);
      }
    } else {
      entry.usd += row.estimated_usd;
    }
  }

  const unpricedModels = new Set<string>();
  for (const entry of byDate.values()) {
    entry.unpriced.forEach((m) => unpricedModels.add(m));
  }

  const daily: DailyCost[] = [...byDate.entries()].map(([date, entry]) => ({
    date,
    usd: entry.usd,
    inputTokens: entry.input,
    outputTokens: entry.output,
  })).sort((a, b) => a.date.localeCompare(b.date));

  const totalUsd    = daily.reduce((s, d) => s + d.usd, 0);
  const totalInput  = daily.reduce((s, d) => s + d.inputTokens, 0);
  const totalOutput = daily.reduce((s, d) => s + d.outputTokens, 0);
  const activeDays  = Math.max(daily.length, 1);
  const dailyAvg    = totalUsd / activeDays;

  return {
    period: periodLabel,
    startDate,
    endDate: today,
    totalUsd,
    inputTokens: totalInput,
    outputTokens: totalOutput,
    dailyAvg,
    monthEstimate: dailyAvg * 30,
    daily,
    unpricedModels: unpricedModels.size > 0 ? [...unpricedModels] : undefined,
  };
}

export function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function todayString(): string {
  return formatDate(new Date());
}
