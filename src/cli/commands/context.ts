import fs from "fs";
import path from "path";
import { ResolvedConfig } from "../../core/config.js";
import { openDb } from "../../core/db.js";
import { getActiveSession, findJsonlPath } from "../../core/session-store.js";
import { parseSessionStats } from "../../core/jsonl-parser.js";
import { analyzeWorkspaceFiles } from "../../engines/file-analyzer.js";
import {
  header, makeTable, fmtTokens, truncBadge, outputJson, severity, getWindowSize, divider,
} from "../format.js";

interface ContextOptions {
  agent?: string;
  json?: boolean;
}

/** Rough token estimate: chars / 4 */
function estTok(chars: number): number {
  return Math.ceil(chars / 4);
}

function fmtTok(n: number): string {
  return `~${fmtTokens(n)} tok`;
}

/** Try to read a text file from the workspace dir */
function readWsFile(workspaceDir: string, name: string): string | null {
  const p = path.join(workspaceDir, name);
  if (!fs.existsSync(p)) return null;
  try { return fs.readFileSync(p, "utf-8"); } catch { return null; }
}

/** Scan skill files in workspace (*.skill.md or skills/ subdir) */
interface SkillInfo { name: string; chars: number; }
function scanSkills(workspaceDir: string): SkillInfo[] {
  const results: SkillInfo[] = [];
  if (!fs.existsSync(workspaceDir)) return results;

  // skills/ subdirectory
  const skillsDir = path.join(workspaceDir, "skills");
  if (fs.existsSync(skillsDir) && fs.statSync(skillsDir).isDirectory()) {
    for (const f of fs.readdirSync(skillsDir)) {
      if (f.endsWith(".md") || f.endsWith(".txt")) {
        try {
          const content = fs.readFileSync(path.join(skillsDir, f), "utf-8");
          results.push({ name: path.basename(f, path.extname(f)), chars: content.length });
        } catch { /* skip */ }
      }
    }
  }
  return results.sort((a, b) => b.chars - a.chars);
}

export async function runContext(cfg: ResolvedConfig, opts: ContextOptions): Promise<void> {
  const agent = opts.agent ?? cfg.probe.openclaw.agent;
  const db = openDb(cfg.probeDir);

  const analysis = analyzeWorkspaceFiles(cfg.workspaceDir, cfg.bootstrapMaxChars);
  const activeSession = getActiveSession(cfg.sessionsDir);

  // Read jsonl transcript for accurate context token count.
  // Transcripts are named by session UUID, not the human-readable sessionKey.
  const transcriptPath = activeSession ? findJsonlPath(cfg.sessionsDir, activeSession) : null;
  const jsonlStats = transcriptPath ? parseSessionStats(transcriptPath) : null;

  // sessionTokens = actual context usage (from last assistant usage.totalTokens in jsonl)
  const sessionTokens = jsonlStats?.lastTotalTokens ?? activeSession?.sessionTokens ?? 0;
  const windowSize = (activeSession?.windowSize || activeSession?.contextTokens) ?? 0;
  const model = jsonlStats?.model ?? activeSession?.modelOverride ?? null;
  const resolvedWindowSize = getWindowSize(model, windowSize || sessionTokens);

  // ── Estimate fixed-cost components ──────────────────────────────────────
  // System prompt: read SOUL.md as proxy if present; otherwise estimate from known agents
  const soulContent = readWsFile(cfg.workspaceDir, "SOUL.md") ?? "";
  const agentsContent = readWsFile(cfg.workspaceDir, "AGENTS.md") ?? "";
  const identityContent = readWsFile(cfg.workspaceDir, "IDENTITY.md") ?? "";
  const heartbeatContent = readWsFile(cfg.workspaceDir, "HEARTBEAT.md") ?? "";
  const bootstrapContent = readWsFile(cfg.workspaceDir, "BOOTSTRAP.md") ?? "";

  // Skills
  const skills = scanSkills(cfg.workspaceDir);
  const skillsChars = skills.reduce((s, sk) => s + sk.chars, 0);

  // Workspace files total (injected)
  const wsFiles = analysis.files;
  const wsTotalInjectedChars = wsFiles.reduce((s, f) => s + f.injectedChars, 0);
  const wsTotalInjectedTokens = wsFiles.reduce((s, f) => s + f.injectedEstTokens, 0);

  // Session history = sessionTokens - all fixed overhead
  // Fixed overhead = workspace files + system prompt estimate
  const fixedOverheadTokens = wsTotalInjectedTokens;
  const sessionHistoryTokens = sessionTokens > fixedOverheadTokens
    ? sessionTokens - fixedOverheadTokens
    : sessionTokens > 0 ? sessionTokens : 0;

  if (opts.json) {
    outputJson({
      agent,
      workspaceDir: cfg.workspaceDir,
      bootstrapMaxChars: cfg.bootstrapMaxChars,
      sessionTokens,
      windowSize: resolvedWindowSize,
      utilizationPct: resolvedWindowSize > 0 ? Math.round(sessionTokens / resolvedWindowSize * 100) : 0,
      workspaceFiles: wsFiles.map((f) => ({
        name: f.name,
        rawChars: f.rawChars,
        injectedChars: f.injectedChars,
        wasTruncated: f.wasTruncated,
        estTokens: f.injectedEstTokens,
      })),
      sessionHistoryTokensEst: sessionHistoryTokens,
    });
    return;
  }

  header("🔍", "Context Analysis", `agent: ${agent}`);

  // ── Overall context bar ──────────────────────────────────────────────────
  if (sessionTokens > 0) {
    const { tokenBar } = await import("../format.js");
    const pct = Math.round(sessionTokens / resolvedWindowSize * 100);
    console.log(
      `  Context used:  ${fmtTokens(sessionTokens)} / ${fmtTokens(resolvedWindowSize)} tokens  ` +
      `${tokenBar(sessionTokens, resolvedWindowSize)}  ${pct}%`
    );
    console.log();
  } else {
    console.log(severity.muted(`  Context window: ${fmtTokens(resolvedWindowSize)} tokens (actual usage not available)`));
    console.log();
  }

  // ── Workspace directory info ─────────────────────────────────────────────
  console.log(severity.muted(`  Workspace:        ${cfg.workspaceDir}`));
  console.log(severity.muted(`  Bootstrap max:    ${cfg.bootstrapMaxChars.toLocaleString()} chars / file`));
  console.log();

  // ── Injected workspace files ─────────────────────────────────────────────
  console.log(severity.bold("  Injected workspace files:"));
  console.log();

  if (wsFiles.length === 0) {
    console.log(severity.muted("    (none found)"));
  } else {
    const table = makeTable(
      ["File", "Raw", "Injected", "~Tokens", "Status"],
      [18, 14, 14, 10, 12]
    );
    for (const f of wsFiles) {
      table.push([
        f.name,
        `${f.rawChars.toLocaleString()} chars`,
        `${f.injectedChars.toLocaleString()} chars`,
        fmtTok(f.injectedEstTokens),
        truncBadge(f.wasTruncated),
      ]);
    }
    console.log(table.toString());

    if (analysis.truncatedFiles.length > 0) {
      for (const f of analysis.truncatedFiles) {
        console.log(
          severity.warning(
            `  ⚠ ${f.name}: ${f.lostChars.toLocaleString()} chars (${Math.round(f.lostPercent)}%) truncated — model never sees this content`
          )
        );
      }
      console.log();
    }

    console.log(
      `  Workspace subtotal:  ~${fmtTokens(wsTotalInjectedTokens)} tokens  ` +
      severity.muted(`(${wsFiles.length} files, ${wsTotalInjectedChars.toLocaleString()} chars injected)`)
    );
  }
  console.log();

  // ── Skills (if found) ────────────────────────────────────────────────────
  if (skills.length > 0) {
    console.log(severity.bold(`  Skills (${skills.length} loaded):`));
    console.log();
    const skillTable = makeTable(["Skill", "Chars", "~Tokens"], [24, 12, 12]);
    for (const sk of skills.slice(0, 10)) {
      skillTable.push([sk.name, sk.chars.toLocaleString(), fmtTok(estTok(sk.chars))]);
    }
    if (skills.length > 10) {
      skillTable.push([`… +${skills.length - 10} more`, "", ""]);
    }
    console.log(skillTable.toString());
    console.log(`  Skills subtotal:  ~${fmtTokens(estTok(skillsChars))} tokens`);
    console.log();
  }

  // ── Session history estimate ─────────────────────────────────────────────
  if (sessionTokens > 0) {
    console.log(severity.bold("  Session history estimate:"));
    console.log();
    console.log(`  Total in context:  ${fmtTokens(sessionTokens)} tokens`);
    console.log(`  Fixed overhead:    ~${fmtTokens(fixedOverheadTokens)} tokens  ` +
      severity.muted("(workspace files)"));
    console.log(`  Conversation est:  ~${fmtTokens(sessionHistoryTokens)} tokens  ` +
      severity.muted("(messages + system prompt + tools)"));
    console.log();
    console.log(severity.muted("  Note: For exact breakdown, run: /context detail  inside OpenClaw"));
  } else {
    console.log(severity.muted("  Session token data not available."));
    console.log(severity.muted("  Start a session and ensure the daemon is running: clawprobe start"));
  }

  console.log();

  // ── Remaining headroom ───────────────────────────────────────────────────
  if (sessionTokens > 0 && resolvedWindowSize > 0) {
    const remaining = resolvedWindowSize - sessionTokens;
    const remainingPct = Math.round(remaining / resolvedWindowSize * 100);
    console.log(
      severity.bold("  Remaining headroom:") +
      `  ${fmtTokens(remaining)} tokens (${remainingPct}%)`
    );
    if (remaining < resolvedWindowSize * 0.1) {
      console.log(severity.warning("  ⚠ Less than 10% context remaining — compaction may be needed soon"));
    }
    console.log();
  }
}
