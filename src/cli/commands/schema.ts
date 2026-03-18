/**
 * `clawprobe schema [command]`
 *
 * Outputs the JSON output schema for each command, intended for agent/tool
 * integration. Agents can call this to understand what fields to expect from
 * each command's --json output before parsing it.
 */

const SCHEMAS: Record<string, unknown> = {
  status: {
    description: "Comprehensive agent status dashboard. Always exits 0.",
    fields: {
      agent:          "string — agent name",
      daemonRunning:  "boolean — whether the background daemon process is alive",
      sessionKey:     "string | null — active session human-readable key",
      sessionId:      "string | null — active session UUID",
      model:          "string | null — model identifier in use",
      provider:       "string | null — provider name",
      sessionTokens:  "number — current context window occupancy (tokens)",
      windowSize:     "number — model context window size (tokens)",
      utilizationPct: "number — context utilization 0–100",
      inputTokens:    "number — cumulative input tokens this session",
      outputTokens:   "number — cumulative output tokens this session",
      compactionCount:"number — number of compaction events this session",
      lastActiveAt:   "number — unix seconds of last activity (0 if unknown)",
      isActive:       "boolean — true when querying the active session",
      todayUsd:       "number — estimated cost today in USD",
      suggestions: [
        {
          severity: "string — 'critical' | 'warning' | 'info'",
          ruleId:   "string — rule identifier, usable with suggest --dismiss",
          title:    "string — short human-readable title",
          detail:   "string — full explanation",
          action:   "string | null — recommended remediation step",
        },
      ],
    },
  },

  cost: {
    description: "Cost summary for a time period. Always exits 0.",
    fields: {
      period:         "string — human-readable period label",
      startDate:      "string — ISO date YYYY-MM-DD",
      endDate:        "string — ISO date YYYY-MM-DD",
      totalUsd:       "number — total estimated cost in USD",
      inputTokens:    "number — total input tokens",
      outputTokens:   "number — total output tokens",
      cacheReadTokens:"number — total cache-read tokens",
      cacheWriteTokens:"number — total cache-write tokens",
      inputUsd:       "number — cost from input tokens at actual model rates",
      outputUsd:      "number — cost from output tokens at actual model rates",
      dailyAvg:       "number — average daily cost over the window",
      monthEstimate:  "number — projected 30-day cost at current rate",
      daily: [
        {
          date:        "string — ISO date",
          usd:         "number — cost that day",
          inputTokens: "number",
          outputTokens:"number",
        },
      ],
      unpricedModels: "string[] | undefined — model IDs with no price data",
    },
  },

  session: {
    description: "Single session cost and turn breakdown. Errors exit 1 with JSON {ok,error,message}.",
    errorShape: { ok: false, error: "string error code", message: "string" },
    fields: {
      sessionKey:     "string",
      model:          "string | null",
      provider:       "string | null",
      inputTokens:    "number — cumulative input tokens",
      outputTokens:   "number — cumulative output tokens",
      totalTokens:    "number",
      contextTokens:  "number — current context window occupancy",
      estimatedUsd:   "number — total cost estimate",
      startedAt:      "number — unix seconds",
      lastActiveAt:   "number — unix seconds",
      durationMin:    "number — session duration in minutes",
      compactionCount:"number",
      costAccurate:   "boolean — true when computed from jsonl transcript",
      isOrphan:       "boolean — true if no sessions.json entry exists",
      turns: [
        {
          turnIndex:        "number — 1-based",
          timestamp:        "number — unix seconds",
          inputTokensDelta: "number — input tokens sent this turn (full context)",
          outputTokensDelta:"number — output tokens generated this turn",
          estimatedUsd:     "number — cost for this turn",
          compactOccurred:  "boolean",
        },
      ],
    },
  },

  "session --list": {
    description: "List of all sessions. Always exits 0.",
    fields: "Array of session objects (same shape as session, minus turns array)",
  },

  context: {
    description: "Context window utilization analysis. Always exits 0.",
    fields: {
      agent:                    "string",
      sessionTokens:            "number — current tokens in context",
      windowSize:               "number — model window size",
      utilizationPct:           "number — 0–100",
      workspaceOverheadTokensEst:"number — estimated tokens used by injected workspace files",
      sessionHistoryTokensEst:  "number — estimated tokens used by conversation history",
      truncatedFiles: [
        { name: "string", lostPct: "number — percentage of file lost to truncation" },
      ],
    },
  },

  suggest: {
    description: "Optimization suggestions from built-in rules. Always exits 0.",
    fields: "Array of suggestion objects",
    itemFields: {
      id:       "number — DB row id",
      ruleId:   "string — rule identifier",
      severity: "string — 'critical' | 'warning' | 'info'",
      title:    "string",
      detail:   "string",
      action:   "string | null",
    },
  },

  compacts: {
    description: "Recent compaction events. Always exits 0. --save errors exit 1 with JSON {ok,error,message}.",
    errorShape: { ok: false, error: "string error code", message: "string" },
    fields: "Array of compact event objects",
    itemFields: {
      id:                   "number — DB row id, usable with compacts --save",
      sessionKey:           "string",
      compactionEntryId:    "string",
      tokensBefore:         "number | null",
      compactedAt:          "number | null — unix seconds",
      compactedMessageCount:"number | null",
      summaryText:          "string | null",
      compactedMessages:    "Array of {role, content, id} objects",
    },
  },
};

export function runSchema(commandName?: string): void {
  if (commandName) {
    const schema = SCHEMAS[commandName];
    if (!schema) {
      const available = Object.keys(SCHEMAS).join(", ");
      console.log(JSON.stringify({
        ok: false,
        error: "unknown_command",
        message: `No schema for '${commandName}'. Available: ${available}`,
      }, null, 2));
      process.exit(1);
    }
    console.log(JSON.stringify(schema, null, 2));
  } else {
    // List all available schemas with their descriptions
    const index = Object.entries(SCHEMAS).reduce<Record<string, string>>((acc, [k, v]) => {
      acc[k] = (v as { description: string }).description ?? "";
      return acc;
    }, {});
    console.log(JSON.stringify({
      usage: "clawprobe schema <command>",
      available: index,
    }, null, 2));
  }
}
