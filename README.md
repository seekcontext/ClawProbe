# clawprobe

**The Missing Observability Layer for OpenClaw**

See what your agent thinks. Track what it forgets. Know what you spend.

[![npm](https://img.shields.io/npm/v/clawprobe)](https://www.npmjs.com/package/clawprobe)
[![npm downloads](https://img.shields.io/npm/dm/clawprobe)](https://www.npmjs.com/package/clawprobe)
[![GitHub Stars](https://img.shields.io/github/stars/seekcontext/ClawProbe)](https://github.com/seekcontext/ClawProbe)
[![License](https://img.shields.io/github/license/seekcontext/ClawProbe)](./LICENSE)

[Why clawprobe](#why-clawprobe) •
[Features](#features) •
[Quick Start](#quick-start) •
[How It Works](#how-it-works) •
[CLI Reference](#cli-reference) •
[Configuration](#configuration) •
[Roadmap](#roadmap)

---

## Why clawprobe

Your OpenClaw agent runs on token budgets, compacted memories, and injected context files — but none of that is visible to you while it's happening.

Three problems, no good solution:

- **Context opacity** — How full is the context window right now? What's eating it? OpenClaw's built-in `/context detail` is useful but not always accessible mid-task.
- **Silent memory loss** — Compaction silently discards conversation context. Agreed-upon decisions, file paths, preferences — gone without notice.
- **Memory is a black box** — What does your agent actually remember? Editing `MEMORY.md` by hand is the only option.

**clawprobe** gives you X-ray vision into your agent — without touching a single line of OpenClaw's internals:

- **Real-time status** — See context utilization, active model, compaction count, and session info at a glance.
- **Context breakdown** — Know exactly which workspace files consume how many tokens and whether any are being silently truncated.
- **Compact tracking** — Every compaction event is captured. See what was discarded, and save important context to long-term memory before it's gone.
- **Cost intelligence** — Track your API spend by day, week, or month with per-model pricing.
- **Memory management** — Browse, search, add, and edit your agent's memory from the terminal.
- **Proactive suggestions** — Automatic detection of common issues: truncated tools, excessive compaction, cost spikes, and more.

If your agent's context matters, you should be able to see it.

---

## Features

### Agent Status

See the health of your agent in one command.

```
$ clawprobe status

📊  Agent Status  (active session)
──────────────────────────────────────────────────
  Agent:     main
  Session:   agent:main:feishu:direct:ou_xxx ●
  Model:     kimi-k2.5
  Context:   14.9K / 256.0K tokens  █░░░░░░░░░  6%
  This session: 4.6K in / 498 out
  Compacts:  0
  Last active: Today 15:28
```

### Context Analysis

Understand how the context window is being used, and catch truncation before it causes problems.

```
$ clawprobe context

🔍  Context Analysis  agent: main
──────────────────────────────────────────────────
Context used:  14.9K / 256.0K tokens  █░░░░░░░░░  6%

Injected workspace files:
  AGENTS.md    7,805 chars   ~2.0K tok   ✓ ok
  SOUL.md      1,078 chars   ~270 tok    ✓ ok
  TOOLS.md       851 chars   ~213 tok    ✓ ok

Workspace subtotal:  ~2.8K tokens (7 files)

Session history estimate:
  Total in context:  14.9K tokens
  Fixed overhead:    ~2.8K tokens (workspace files)
  Conversation est:  ~12.2K tokens (messages + system prompt + tools)

Remaining headroom:  241.1K tokens (94%)
```

### Compact Event Tracking

Every time OpenClaw compacts your session, clawprobe captures what was lost and lets you save key context to long-term memory.

```
$ clawprobe compacts

📦  Compact Events  last 5
──────────────────────────────────────────────────

  #1  Today 14:22  [agent:main…]

    3 messages compacted

    Compacted messages:
      👤  "Can you help me check if MEMORY.md is being tracked?"
      🤖  "Yes, MEMORY.md has been added and is pending commit."

    → Save to memory: clawprobe memory save-compact 1
```

### Cost Tracking

See where your API budget goes, broken down by day.

```
$ clawprobe cost --week

💰  Weekly Cost  Mar 10 – Mar 17, 2026
──────────────────────────────────────────────────
  Total:     $0.00
  Daily avg: $0.00
  Month est: $0.00

  2026-03-17  ██  $0.00

  Input:   14.4K tokens  $0.00  (93%)
  Output:  1.2K tokens   $0.00  (7%)
```

> **Note:** Cost estimates show $0.00 for Kimi/Moonshot because the API does not return pricing data. Set `customPrices` in `~/.clawprobe/config.json` for accurate estimates.

### Memory Browser

Browse, search, edit, and add to your agent's memory — no more hand-editing Markdown.

```bash
clawprobe memory list                      # List memory entries
clawprobe memory search "database"         # Search memory
clawprobe memory add "Prefer snake_case"   # Add to memory
clawprobe memory save-compact 1            # Save from compact event
```

### Optimization Suggestions

clawprobe continuously checks for common issues and tells you what to fix.

```
$ clawprobe suggest

💡  Optimization Suggestions  agent: main
──────────────────────────────────────────────────

  ✓ No issues detected. Your agent looks healthy.
```

Rules checked:

| Rule | What It Detects |
|------|----------------|
| TOOLS.md truncation | File exceeds bootstrap limit — tools silently cut off |
| High compaction frequency | Context fills up too fast (< 30 min intervals) |
| Context leak | Context tokens > 90% of model window |
| Cost spike | Today's cost > 2x weekly average |
| Memory bloat | MEMORY.md exceeds recommended size |
| Stale workspace files | Files unchanged for 30+ days |

---

## Quick Start

### Requirements

- Node.js ≥ 22
- OpenClaw installed and configured
- macOS or Linux (Windows via WSL2)

### Install

```bash
npm install -g clawprobe
```

### First Run

```bash
clawprobe start      # Start background daemon
clawprobe status     # See what your agent is doing right now
```

clawprobe auto-detects your OpenClaw installation at `~/.openclaw`. No configuration needed.

---

## How It Works

clawprobe reads OpenClaw's existing data files and turns them into actionable insights. No code patches, no plugins, no configuration required.

```
~/.openclaw/                                 clawprobe
──────────────────────────────────           ────────────────────────────────
sessions.json                          →     Session metadata, token counts
*.jsonl transcripts                    →     Compact events, context usage, cost
workspace/*.md (SOUL, AGENTS, TOOLS…)  →     File size analysis, truncation detection
MEMORY.md + memory/*.md                →     Memory browser & editor
openclaw.json                          →     Model, provider, config detection
                                              │
                                              ▼
                                        ~/.clawprobe/probe.db (SQLite)
                                              │
                                              ▼
                                        CLI commands + optimization engine
```

### Why It Just Works

- **Zero configuration** — auto-detects OpenClaw's data directory and active agent
- **Zero side effects** — read-only by default; only writes when you explicitly manage memory
- **No code changes** — reads existing files, never patches OpenClaw internals
- **Background daemon** — `clawprobe start` launches a watcher that tracks changes in real-time, batching updates with a 300ms debounce

### What Gets Tracked

| Data Source | What clawprobe Extracts |
|-------------|------------------------|
| `sessions.json` | Token counts, model, compaction count, session metadata |
| `*.jsonl` transcripts | Individual messages, compaction events with summaries |
| `workspace/*.md` | File sizes, token estimates, truncation status |
| `MEMORY.md` | Memory entries for browsing, searching, and editing |
| `openclaw.json` | Model config, workspace path, bootstrap limits |

---

## CLI Reference

```bash
# Daemon
clawprobe start               # Start background daemon
clawprobe stop                # Stop daemon

# Status & context
clawprobe status              # Current session (tokens, model, compactions)
clawprobe context             # Context window breakdown

# Sessions
clawprobe session             # Active session details + turn timeline
clawprobe session --list      # All sessions
clawprobe session --list --full  # Full session keys (not truncated)

# Cost
clawprobe cost                # This week
clawprobe cost --day          # Today
clawprobe cost --month        # This month

# Compact events
clawprobe compacts            # Last 5 compact events
clawprobe compacts --last 10  # Last 10

# Memory
clawprobe memory list                      # List memory entries
clawprobe memory search "postgres"         # Search memory
clawprobe memory add "prefer snake_case"   # Add to memory
clawprobe memory save-compact <id>         # Save from compact event

# Suggestions
clawprobe suggest             # Show optimization suggestions

# Diagnostics
clawprobe config --diag       # Full diagnostic dump
```

---

## Configuration

Optional config at `~/.clawprobe/config.json`:

```json
{
  "timezone": "Asia/Shanghai",
  "openclaw": {
    "dir": "~/.openclaw",
    "agent": "main"
  },
  "cost": {
    "customPrices": {
      "kimi-k2.5": { "input": 0.004, "output": 0.016 }
    }
  },
  "alerts": {
    "dailyBudgetUsd": 5.00
  }
}
```

Most users need zero configuration. clawprobe auto-detects everything from OpenClaw's existing files.

---

## Architecture

```
clawprobe/
├── src/
│   ├── index.ts              # CLI entry point
│   ├── daemon.ts             # Background daemon (chokidar file watcher)
│   ├── core/
│   │   ├── config.ts         # OpenClaw config auto-detection
│   │   ├── db.ts             # SQLite storage (probe.db)
│   │   ├── watcher.ts        # File system monitoring
│   │   ├── jsonl-parser.ts   # .jsonl transcript parser
│   │   ├── session-store.ts  # sessions.json reader
│   │   └── memory-editor.ts  # MEMORY.md read/write
│   ├── engines/
│   │   ├── cost.ts           # Token-to-USD cost calculation
│   │   ├── compact-diff.ts   # Compaction analysis engine
│   │   ├── file-analyzer.ts  # Workspace file size & truncation
│   │   └── rule-engine.ts    # Optimization suggestion rules
│   └── cli/
│       ├── format.ts         # Terminal output formatting
│       └── commands/         # status, cost, session, compacts, context, suggest, memory
└── test/                     # Unit + integration tests
```

| Layer | Technology | Why |
|-------|-----------|-----|
| Runtime | Node.js ≥ 22 | Matches OpenClaw's requirement |
| Language | TypeScript | Type-safe, matches OpenClaw ecosystem |
| File watching | chokidar | Battle-tested, cross-platform |
| Database | node:sqlite | Built-in, zero dependencies |
| CLI | commander.js | Standard, well-documented |
| Terminal UI | chalk + cli-table3 | Clean output, minimal deps |

**Total production dependencies**: 4 packages.
**No cloud services. No telemetry. No API keys.**

---

## Compatibility

clawprobe works by reading OpenClaw's file system directly. It is compatible with any OpenClaw version that writes `sessions.json` and `.jsonl` transcript files to `~/.openclaw/agents/<agent>/sessions/`.

---

## Privacy

- **100% local** — no data ever leaves your machine
- **Read-only by default** — only writes when you explicitly use `memory add`, `memory edit`, `memory delete`, or `memory save-compact`
- **No telemetry** — clawprobe collects nothing
- **No accounts** — no sign-up, no API keys required

---

## Roadmap

### v0.3 — Visual

- [ ] **Web Dashboard** — Visual timeline, context gauge, cost charts, memory browser at `localhost:4747`
- [ ] **Session timeline** — Turn-by-turn cost breakdown with compact event markers
- [ ] **Side-by-side compact diff** — See exactly what was lost vs. what was summarized

### v0.4 — OpenClaw Skill

- [ ] **In-chat integration** — Ask your agent about its own context, cost, and memory via natural language
- [ ] **Proactive alerts** — Agent warns you when context is near capacity or cost spikes
- [ ] **Auto-save on compact** — Automatically preserve important context before compaction discards it

### v0.5 — Smarter Analysis

- [ ] **ContextEngine adapter** — Hook into the real `assemble()` pipeline for exact token breakdowns
- [ ] **Retrieval visibility** — See what the memory engine searched and what it returned
- [ ] **Cross-session analytics** — Compare context patterns and costs across sessions over time

### Future

- [ ] **Multi-agent support** — Monitor and compare multiple agents side by side
- [ ] **Export & share** — Portable analysis bundles for debugging agent behavior with others
- [ ] **Custom rules** — Define your own optimization rules and alert thresholds

---

## Contributing

Contributions are welcome! clawprobe is open source (MIT).

```bash
git clone https://github.com/seekcontext/ClawProbe
cd ClawProbe
npm install
npm run dev
```

Run tests:

```bash
npm test
```

---

## License

[MIT](./LICENSE) — Use it however you want.
