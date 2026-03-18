import { ResolvedConfig } from "../../core/config.js";
import { openDb } from "../../core/db.js";
import { getPeriodCost } from "../../engines/cost.js";
import {
  header, fmtUsd, fmtTokens, costBar, outputJson, severity, printCostDisclaimer,
} from "../format.js";

interface CostOptions {
  agent?: string;
  day?: boolean;
  week?: boolean;
  month?: boolean;
  all?: boolean;
  json?: boolean;
}

export async function runCost(cfg: ResolvedConfig, opts: CostOptions): Promise<void> {
  const agent = opts.agent ?? cfg.probe.openclaw.agent;
  const db = openDb(cfg.probeDir);

  const period: "day" | "week" | "month" | "all" =
    opts.day ? "day" :
    opts.month ? "month" :
    opts.all ? "all" :
    "week";

  const summary = getPeriodCost(db, agent, period, cfg.probe.cost.customPrices);

  if (opts.json) {
    outputJson(summary);
    return;
  }

  header("💰", `${period === "day" ? "Today's" : period === "week" ? "Weekly" : period === "month" ? "Monthly" : "All-time"} Cost`, summary.period);

  console.log(`  Total:     ${fmtUsd(summary.totalUsd)}`);
  if (period !== "day") {
    console.log(`  Daily avg: ${fmtUsd(summary.dailyAvg)}`);
    console.log(`  Month est: ${fmtUsd(summary.monthEstimate)}`);
  }
  console.log();

  if (summary.daily.length === 0) {
    console.log(severity.muted("  No cost data yet. Run clawprobe as a daemon to collect data."));
    console.log();
    return;
  }

  // Daily chart
  const maxUsd = Math.max(...summary.daily.map((d) => d.usd), 0.01);
  for (const day of summary.daily) {
    const isToday = day.date === new Date().toISOString().slice(0, 10);
    const label = isToday ? severity.bold(day.date) : day.date;
    const bar = costBar(day.usd, maxUsd);
    const usdStr = fmtUsd(day.usd);
    console.log(`  ${label}  ${bar}  ${usdStr}`);
  }

  console.log();
  const totalCostForPct = Math.max(summary.inputUsd + summary.outputUsd, 0.000001);
  console.log(
    `  Input:   ${fmtTokens(summary.inputTokens)} tokens  ${fmtUsd(summary.inputUsd)}` +
    `  (${Math.round((summary.inputUsd / totalCostForPct) * 100)}%)`
  );
  console.log(
    `  Output:  ${fmtTokens(summary.outputTokens)} tokens  ${fmtUsd(summary.outputUsd)}` +
    `  (${Math.round((summary.outputUsd / totalCostForPct) * 100)}%)`
  );

  if (cfg.probe.alerts.dailyBudgetUsd) {
    const budget = cfg.probe.alerts.dailyBudgetUsd;
    const today = summary.daily.find((d) => d.date === new Date().toISOString().slice(0, 10));
    if (today && today.usd > budget * 0.8) {
      console.log();
      console.log(severity.warning(`  ⚠ Today's spend ($${today.usd.toFixed(2)}) is near your daily budget ($${budget.toFixed(2)})`));
    }
  }

  if (summary.unpricedModels && summary.unpricedModels.length > 0) {
    console.log();
    console.log(severity.muted(`  ℹ No price data for: ${summary.unpricedModels.join(", ")}`));
    console.log(severity.muted(`    Add to ~/.clawprobe/config.json → cost.customPrices to enable cost tracking.`));
  }

  console.log();
  printCostDisclaimer();
  console.log();
}
