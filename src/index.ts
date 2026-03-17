#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { spawn } from "child_process";
import { createWriteStream } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Command } from "commander";
import { resolveConfig, assertOpenClawExists } from "./core/config.js";
import { startDaemon } from "./daemon.js";
import { runStatus } from "./cli/commands/status.js";
import { runCost } from "./cli/commands/cost.js";
import { runSession } from "./cli/commands/session.js";
import { runCompacts } from "./cli/commands/compacts.js";
import { runContext } from "./cli/commands/context.js";
import { runSuggest } from "./cli/commands/suggest.js";
import {
  runMemoryList,
  runMemorySearch,
  runMemoryAdd,
  runMemoryEdit,
  runMemoryDelete,
  runMemorySaveCompact,
} from "./cli/commands/memory.js";

const VERSION = "0.1.4";

const program = new Command();

program
  .name("clawprobe")
  .description("Context observability for OpenClaw agents")
  .version(VERSION);

// --- start ---
program
  .command("start")
  .description("Start the background daemon (watches OpenClaw files)")
  .option("--no-browser", "Do not open browser on start")
  .option("--daemon-only", "Start daemon only, no web server")
  .option("--foreground", "Run daemon in foreground (don't detach)")
  .action(async (opts: { foreground?: boolean }) => {
    const cfg = resolveConfig();
    assertOpenClawExists(cfg);

    // Already the daemon process (spawned with CLAWPROBE_DAEMON=1)
    if (process.env.CLAWPROBE_DAEMON === "1") {
      await startDaemon(cfg);
      return;
    }

    // Run in foreground if requested
    if (opts.foreground) {
      await startDaemon(cfg);
      return;
    }

    // Spawn detached daemon and exit (nohup-style)
    const entryPath = fileURLToPath(import.meta.url);
    const daemonLogPath = path.join(cfg.probeDir, "daemon.log");
    const logStream = createWriteStream(daemonLogPath, { flags: "a" });
    const child = spawn(process.execPath, [entryPath, "start"], {
      detached: true,
      stdio: ["ignore", logStream, logStream],
      env: { ...process.env, CLAWPROBE_DAEMON: "1" },
      cwd: process.cwd(),
    });
    child.unref();
    console.log("✓ clawprobe daemon started (detached)");
    console.log(`✓ Watching: ${cfg.openclawDir}`);
    console.log(`✓ Logs: ${daemonLogPath}`);
    process.exit(0);
  });

// --- stop ---
program
  .command("stop")
  .description("Stop the running daemon")
  .action(() => {
    console.log("Use your process manager or Ctrl+C to stop the daemon.");
  });

// --- status ---
program
  .command("status")
  .description("Current session status (tokens, model, compactions)")
  .option("--agent <name>", "Target agent")
  .option("--session <key>", "Target session key")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    const cfg = resolveConfig();
    assertOpenClawExists(cfg);
    await runStatus(cfg, opts);
  });

// --- cost ---
program
  .command("cost")
  .description("API cost summary")
  .option("--day", "Today")
  .option("--week", "Current week (default)")
  .option("--month", "Current month")
  .option("--all", "All time")
  .option("--agent <name>", "Target agent")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    const cfg = resolveConfig();
    assertOpenClawExists(cfg);
    await runCost(cfg, opts);
  });

// --- session ---
const sessionCmd = program
  .command("session [session-key]")
  .description("Per-session cost and turn breakdown")
  .option("--list", "List all sessions")
  .option("--no-turns", "Hide turn-by-turn timeline")
  .option("--agent <name>", "Target agent")
  .option("--json", "Output as JSON")
  .action(async (sessionKey, opts) => {
    const cfg = resolveConfig();
    assertOpenClawExists(cfg);
    await runSession(cfg, sessionKey as string | undefined, opts);
  });

// --- compacts ---
program
  .command("compacts")
  .description("Recent compaction events")
  .option("--last <n>", "Number of events to show", "5")
  .option("--agent <name>", "Target agent")
  .option("--session <key>", "Filter by session")
  .option("--show-messages", "Show full message content")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    const cfg = resolveConfig();
    assertOpenClawExists(cfg);
    await runCompacts(cfg, { ...opts, last: parseInt(opts.last, 10) });
  });

// --- context ---
program
  .command("context")
  .description("Context window composition analysis")
  .option("--agent <name>", "Target agent")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    const cfg = resolveConfig();
    assertOpenClawExists(cfg);
    await runContext(cfg, opts);
  });

// --- memory ---
const memoryCmd = program
  .command("memory")
  .description("Memory management subcommands");

memoryCmd
  .command("list")
  .description("List all memory entries")
  .option("--file <path>", "Target memory file")
  .option("--agent <name>", "Target agent")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    const cfg = resolveConfig();
    await runMemoryList(cfg, opts);
  });

memoryCmd
  .command("search <query>")
  .description("Search memory")
  .option("--agent <name>", "Target agent")
  .option("--limit <n>", "Max results", "10")
  .option("--json", "Output as JSON")
  .action(async (query, opts) => {
    const cfg = resolveConfig();
    await runMemorySearch(cfg, query as string, { ...opts, limit: parseInt(opts.limit, 10) });
  });

memoryCmd
  .command("add <content>")
  .description("Add entry to memory")
  .option("--file <path>", "Target memory file")
  .option("--agent <name>", "Target agent")
  .action(async (content, opts) => {
    const cfg = resolveConfig();
    await runMemoryAdd(cfg, content as string, opts);
  });

memoryCmd
  .command("edit <entry-id> [content]")
  .description("Edit a memory entry (opens $EDITOR if content omitted)")
  .option("--file <path>", "Target memory file")
  .option("--agent <name>", "Target agent")
  .action(async (entryId, content, opts) => {
    const cfg = resolveConfig();
    await runMemoryEdit(cfg, parseInt(entryId as string, 10), content as string | undefined, opts);
  });

memoryCmd
  .command("delete <entry-id>")
  .description("Delete a memory entry")
  .option("--file <path>", "Target memory file")
  .option("--agent <name>", "Target agent")
  .option("--yes", "Skip confirmation")
  .action(async (entryId, opts) => {
    const cfg = resolveConfig();
    await runMemoryDelete(cfg, parseInt(entryId as string, 10), opts);
  });

memoryCmd
  .command("save-compact <compact-id>")
  .description("Save compacted messages from a compact event to memory")
  .option("--file <path>", "Target memory file")
  .option("--agent <name>", "Target agent")
  .action(async (compactId, opts) => {
    const cfg = resolveConfig();
    await runMemorySaveCompact(cfg, parseInt(compactId as string, 10), opts);
  });

// --- suggest ---
program
  .command("suggest")
  .description("Optimization suggestions")
  .option("--agent <name>", "Target agent")
  .option("--severity <level>", "Filter: critical | warning | info")
  .option("--dismiss <rule-id>", "Dismiss a suggestion")
  .option("--reset-dismissed", "Un-dismiss all suggestions")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    const cfg = resolveConfig();
    assertOpenClawExists(cfg);
    await runSuggest(cfg, {
      agent: opts.agent,
      severityFilter: opts.severity,
      dismiss: opts.dismiss,
      resetDismissed: opts.resetDismissed,
      json: opts.json,
    });
  });

// --- config ---
program
  .command("config")
  .description("Show detected OpenClaw configuration")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const cfg = resolveConfig();
    if (opts.json) {
      console.log(JSON.stringify({ openclawDir: cfg.openclawDir, workspaceDir: cfg.workspaceDir, sessionsDir: cfg.sessionsDir, bootstrapMaxChars: cfg.bootstrapMaxChars, probeDir: cfg.probeDir, openclaw: cfg.openclaw }, null, 2));
    } else {
      console.log(`OpenClaw dir:      ${cfg.openclawDir}`);
      console.log(`Workspace:         ${cfg.workspaceDir}`);
      console.log(`Sessions:          ${cfg.sessionsDir}`);
      console.log(`Bootstrap max:     ${cfg.bootstrapMaxChars.toLocaleString()} chars`);
      console.log(`probe.db:          ${cfg.probeDir}/probe.db`);
      const model = cfg.openclaw.models?.default;
      if (model) console.log(`Default model:     ${model}`);
      const engine = cfg.openclaw.plugins?.slots?.contextEngine;
      if (engine) console.log(`Context engine:    ${engine}`);
    }
  });

program.parse(process.argv);
