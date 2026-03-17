import { ResolvedConfig } from "../../core/config.js";
import { openDb, dismissSuggestion, resetDismissed, getSuggestions } from "../../core/db.js";
import { runRules, persistSuggestions, ProbeState } from "../../engines/rule-engine.js";
import {
  header, outputJson, severity, SEVERITY_ICON, printSuccess,
} from "../format.js";

interface SuggestOptions {
  agent?: string;
  severityFilter?: string;
  dismiss?: string;
  resetDismissed?: boolean;
  json?: boolean;
}

export async function runSuggest(cfg: ResolvedConfig, opts: SuggestOptions): Promise<void> {
  const agent = opts.agent ?? cfg.probe.openclaw.agent;
  const db = openDb(cfg.probeDir);

  if (opts.dismiss) {
    dismissSuggestion(db, agent, opts.dismiss);
    printSuccess(`Dismissed suggestion: ${opts.dismiss}`);
    return;
  }

  if (opts.resetDismissed) {
    resetDismissed(db, agent);
    printSuccess("Reset all dismissed suggestions.");
    return;
  }

  // Run rules and persist
  const state: ProbeState = {
    db,
    agent,
    workspaceDir: cfg.workspaceDir,
    sessionsDir: cfg.sessionsDir,
    bootstrapMaxChars: cfg.bootstrapMaxChars,
    config: cfg.probe,
  };

  const suggestions = runRules(state);
  persistSuggestions(db, agent, suggestions);

  // Read back from db (respects dismissed)
  const rows = getSuggestions(db, agent, opts.severityFilter);

  if (opts.json) {
    outputJson(rows.map((r) => ({
      id: r.id,
      ruleId: r.rule_id,
      severity: r.severity,
      title: r.title,
      detail: r.detail,
      action: r.action,
    })));
    return;
  }

  header("💡", "Optimization Suggestions", `agent: ${agent}`);

  if (rows.length === 0) {
    console.log(severity.ok("  ✓ No issues detected. Your agent looks healthy."));
    console.log();
    return;
  }

  for (const row of rows) {
    const icon = SEVERITY_ICON[row.severity] ?? "•";
    const sevLabel = row.severity.toUpperCase().padEnd(8);
    const sevColor =
      row.severity === "critical" ? severity.critical :
      row.severity === "warning" ? severity.warning :
      severity.info;

    console.log();
    console.log(`  ${icon}  ${sevColor(sevLabel)}  ${severity.bold(row.title)}`);
    console.log();
    console.log(`     ${row.detail}`);
    if (row.action) {
      console.log();
      console.log(`     ${severity.muted("→")} ${row.action}`);
    }
    console.log();
    console.log(severity.muted(`     [dismiss: clawprobe suggest --dismiss ${row.rule_id}]`));
    console.log();
    console.log(severity.muted("  " + "─".repeat(46)));
  }

  console.log();
}
