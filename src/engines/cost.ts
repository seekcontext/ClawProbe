import { DatabaseSync } from "node:sqlite";
import {
  getDailyCostSummary,
  getAllSessionKeys,
  getFirstSnapshot,
  getLatestSnapshot,
  getAllSnapshots,
  upsertCostRecord,
} from "../core/db.js";
import type { SessionEntry } from "../core/session-store.js";

// USD per 1M tokens
export const MODEL_PRICES: Record<string, { input: number; output: number }> = {
  // Anthropic
  "anthropic/claude-opus-4":         { input: 15.00, output: 75.00 },
  "anthropic/claude-sonnet-4.5":     { input: 3.00,  output: 15.00 },
  "anthropic/claude-haiku-3.5":      { input: 0.80,  output: 4.00  },
  // OpenAI
  "openai/gpt-5.4":                  { input: 5.00,  output: 20.00 },
  "openai/gpt-5.4-mini":             { input: 0.30,  output: 1.20  },
  "openai/o4-mini":                  { input: 1.10,  output: 4.40  },
  // Google
  "google/gemini-3.1-flash":         { input: 0.075, output: 0.30  },
  "google/gemini-3.1-pro":           { input: 1.25,  output: 5.00  },
  // DeepSeek
  "deepseek/deepseek-v3":            { input: 0.27,  output: 1.10  },
  "deepseek/deepseek-r2":            { input: 0.55,  output: 2.19  },
};

export interface TokenCount {
  input: number;
  output: number;
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
}

export interface SessionCost {
  sessionKey: string;
  model: string | null;
  provider: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
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
  customPrices: Record<string, { input: number; output: number }> = {}
): number {
  if (!model) return 0;

  const prices = { ...MODEL_PRICES, ...customPrices };

  // Try exact match first, then prefix-match (e.g. "claude-sonnet" → anthropic/claude-sonnet-*)
  const price =
    prices[model] ??
    Object.entries(prices).find(([key]) => model.includes(key.split("/")[1] ?? key))?.[1];

  if (!price) return 0;

  return (tokens.input / 1_000_000) * price.input +
         (tokens.output / 1_000_000) * price.output;
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
    estimatedUsd: estimateCost({ input: totalInput, output: totalOutput }, model, customPrices),
    startedAt: first.sampled_at,
    lastActiveAt: last.sampled_at,
    durationMin: Math.round((last.sampled_at - first.sampled_at) / 60),
    compactionCount: last.compaction_count,
    // costAccurate means we have the real cumulative totals (always true when we have snapshots)
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
    estimatedUsd: usd,
    startedAt: entry.updatedAt,
    lastActiveAt: entry.updatedAt,
    durationMin: 0,
    compactionCount: entry.compactionCount,
    costAccurate: false,
    turns: [],
  };
}

export function getAllSessionCosts(
  db: DatabaseSync,
  agent: string,
  customPrices: Record<string, { input: number; output: number }> = {}
): SessionCost[] {
  const keys = getAllSessionKeys(db, agent);
  return keys
    .map(({ session_key }) => getSessionCost(db, agent, session_key, customPrices))
    .filter((s): s is SessionCost => s !== null);
}

export function getPeriodCost(
  db: DatabaseSync,
  agent: string,
  period: "day" | "week" | "month" | "all",
  customPrices: Record<string, { input: number; output: number }> = {}
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

  const rows = getDailyCostSummary(db, agent, days);

  const daily: DailyCost[] = rows.map((r) => ({
    date: r.date,
    usd: r.total_usd,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
  }));

  const totalUsd = daily.reduce((s, d) => s + d.usd, 0);
  const totalInput = daily.reduce((s, d) => s + d.inputTokens, 0);
  const totalOutput = daily.reduce((s, d) => s + d.outputTokens, 0);
  const activeDays = Math.max(daily.length, 1);
  const dailyAvg = totalUsd / activeDays;

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
  };
}

export function recordDailyCost(
  db: DatabaseSync,
  agent: string,
  sessionKey: string,
  date: string,
  inputDelta: number,
  outputDelta: number,
  model: string | null,
  customPrices: Record<string, { input: number; output: number }> = {}
): void {
  const usd = estimateCost({ input: inputDelta, output: outputDelta }, model, customPrices);
  upsertCostRecord(db, {
    agent,
    session_key: sessionKey,
    date,
    input_tokens: inputDelta,
    output_tokens: outputDelta,
    model,
    estimated_usd: usd,
    recorded_at: Math.floor(Date.now() / 1000),
  });
}

export function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function todayString(): string {
  return formatDate(new Date());
}
