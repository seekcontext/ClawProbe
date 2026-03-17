import { ResolvedConfig } from "../../core/config.js";
import { openDb } from "../../core/db.js";
import { getActiveSession } from "../../core/session-store.js";
import { getLatestWorkspaceAnalysis } from "../../engines/file-analyzer.js";
import {
  header, makeTable, fmtTokens, truncBadge, outputJson, severity, getWindowSize,
} from "../format.js";

interface ContextOptions {
  agent?: string;
  json?: boolean;
}

export async function runContext(cfg: ResolvedConfig, opts: ContextOptions): Promise<void> {
  const agent = opts.agent ?? cfg.probe.openclaw.agent;
  const db = openDb(cfg.probeDir);

  const analysis = getLatestWorkspaceAnalysis(
    db,
    agent,
    cfg.workspaceDir,
    cfg.bootstrapMaxChars
  );

  const activeSession = getActiveSession(cfg.sessionsDir);
  const contextTokens = activeSession?.contextTokens ?? 0;
  const windowSize = getWindowSize(activeSession?.modelOverride ?? null, contextTokens);

  if (opts.json) {
    outputJson({
      agent,
      bootstrapMaxChars: analysis.bootstrapMaxChars,
      contextTokens,
      windowSize,
      files: analysis.files.map((f) => ({
        name: f.name,
        rawChars: f.rawChars,
        injectedChars: f.injectedChars,
        wasTruncated: f.wasTruncated,
        lostChars: f.lostChars,
        lostPercent: Math.round(f.lostPercent),
        estTokens: f.estTokens,
        injectedEstTokens: f.injectedEstTokens,
      })),
    });
    return;
  }

  header("🔍", "Context Analysis", `agent: ${agent}`);

  console.log(severity.bold("  Workspace files (injected at session start):"));
  console.log();

  const table = makeTable(
    ["File", "Raw size", "Injected", "~Tokens", "Status"],
    [16, 14, 14, 10, 14]
  );

  for (const f of analysis.files) {
    table.push([
      f.name,
      `${f.rawChars.toLocaleString()} chars`,
      f.wasTruncated
        ? `${f.injectedChars.toLocaleString()} chars`
        : `${f.injectedChars.toLocaleString()} chars`,
      `~${fmtTokens(f.injectedEstTokens)}`,
      truncBadge(f.wasTruncated),
    ]);
  }

  console.log(table.toString());

  if (analysis.truncatedFiles.length > 0) {
    console.log();
    for (const f of analysis.truncatedFiles) {
      console.log(
        severity.warning(
          `  ⚠ ${f.name}: ${f.lostChars.toLocaleString()} chars (${Math.round(f.lostPercent)}%) are never seen by the model`
        )
      );
    }
  }

  console.log();
  console.log(severity.bold("  Token estimates:"));
  console.log();

  const totalWorkspaceTokens = analysis.files.reduce((s, f) => s + f.injectedEstTokens, 0);

  if (contextTokens > 0) {
    console.log(`  Context window (from session): ${fmtTokens(contextTokens)} / ${fmtTokens(windowSize)} tokens`);
  }
  console.log(`  Workspace files (estimate):    ~${fmtTokens(totalWorkspaceTokens)} tokens`);
  if (contextTokens > 0) {
    const remaining = windowSize - contextTokens;
    console.log(`  Remaining headroom:            ${fmtTokens(remaining)} tokens`);
  }

  console.log();
}
