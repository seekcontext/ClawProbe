# clawprobe User Manual

> Version 1.0  
> For OpenClaw users who want full visibility into their agent's context, costs, tool usage, todos, and memory.

---

## Table of Contents

1. [Installation](#1-installation)
2. [Getting Started](#2-getting-started)
3. [Understanding clawprobe](#3-understanding-clawprobe)
4. [Monitoring Costs](#4-monitoring-costs)
5. [Tracking a Single Session's Cost](#5-tracking-a-single-sessions-cost)
6. [Tracking Compact Events](#6-tracking-compact-events)
7. [Managing Memory](#7-managing-memory)
8. [Context Analysis](#8-context-analysis)
9. [Optimization Suggestions](#9-optimization-suggestions)
10. [Web Dashboard](#10-web-dashboard)
11. [IM Bot Integration (OpenClaw Skill)](#11-im-bot-integration-openclaw-skill)
12. [Configuration](#12-configuration)
13. [Troubleshooting](#13-troubleshooting)
14. [Command Reference](#14-command-reference)

---

## 1. Installation

### Requirements

- **Node.js** ≥ 22 — [nodejs.org](https://nodejs.org)
- **OpenClaw** installed (clawprobe will auto-detect it at `~/.openclaw`)
- **macOS or Linux** (Windows: use WSL2)

### Install clawprobe

```bash
npm install -g clawprobe
```

Verify installation:

```bash
clawprobe version
# clawprobe v0.1.0
```

### Auto-detection

When you first run clawprobe, it looks for OpenClaw at:

1. `~/.openclaw` (default)
2. `OPENCLAW_DIR` environment variable (if set)
3. `clawprobe.openclaw.dir` in `~/.clawprobe/config.json` (if set)

If auto-detection fails, see [Configuration](#11-configuration).

---

## 2. Getting Started

### Start the daemon

```bash
clawprobe start
```

This starts:
- A background daemon that watches OpenClaw's files
- A local web dashboard at `http://localhost:4747`

You'll see:

```
✓ clawprobe daemon started (pid 12345)
✓ Watching: ~/.openclaw
✓ Dashboard: http://localhost:4747
```

### Check current status

```bash
clawprobe status
```

Output:

```
📊 Agent Status

  Agent:     main
  Session:   sess_abc123
  Model:     claude-sonnet-4.5
  Provider:  anthropic

  Context:   31,204 / 128,000 tokens  ██████░░░░░░░░░░░░  24%
  Today:     $3.21  (41,200 input + 11,800 output tokens)
  Compacts:  3 this session

  Last activity: 4 min ago
```

### Stop the daemon

```bash
clawprobe stop
```

---

## 3. Understanding clawprobe

### What clawprobe reads

clawprobe reads these OpenClaw files (it never modifies them):

| File | What clawprobe does with it |
|------|-----------------------------|
| `~/.openclaw/agents/main/sessions/sessions.json` | Token counts, compaction stats, model info |
| `~/.openclaw/agents/main/sessions/<sessionKey>.jsonl` | Transcript parsing: turns, tools, todos, sub-agents, compact events |
| `~/.openclaw/openclaw.json` | Config detection (model, workspace path, etc.) |
| `~/.openclaw/workspace/TOOLS.md` | Size and truncation analysis |
| `~/.openclaw/workspace/MEMORY.md` | Memory bloat detection |

### Where clawprobe stores its data

clawprobe keeps its own database at `~/.clawprobe/probe.db`. This is a SQLite file containing:
- Historical token and cost snapshots
- Parsed compact events and their content
- File size history
- Generated optimization suggestions
- Per-session tool usage statistics
- Todo list snapshots
- Sub-agent invocation records

This file is **never shared with any external service**.

---

## 4. Monitoring Costs

### View this week's cost

```bash
clawprobe cost
```

```
💰 Weekly Cost (Mar 10 – Mar 17, 2026)

  Total:     $18.42
  Daily avg:  $2.63
  Month est: $78.90

  Mon  ██████████    $3.21
  Tue  ████████      $2.84
  Wed  ████████████████  $4.12  ← peak
  Thu  ██████        $2.10
  Fri  █████████     $2.95
  Sat  ████          $1.52
  Sun  █████         $1.68

  Breakdown by token type:
  Input tokens:   412,000  $14.42  (78%)
  Output tokens:  115,000   $4.00  (22%)
```

### View different time periods

```bash
clawprobe cost --day      # Today only
clawprobe cost --week     # Current week (default)
clawprobe cost --month    # Current month
clawprobe cost --all      # All time
```

### View cost as JSON (for scripting)

```bash
clawprobe cost --week --json
```

```json
{
  "period": "week",
  "start": "2026-03-10",
  "end": "2026-03-17",
  "totalUsd": 18.42,
  "dailyAvg": 2.63,
  "monthEstimate": 78.9,
  "inputTokens": 412000,
  "outputTokens": 115000,
  "model": "claude-sonnet-4.5",
  "daily": [
    { "date": "2026-03-10", "usd": 3.21, "inputTokens": 45000, "outputTokens": 12000 }
  ]
}
```

### How costs are calculated

clawprobe uses token counts from `sessions.json` and a built-in model price table (USD per 1M tokens). The calculation:

```
cost = (inputTokens / 1,000,000 × inputPrice) + (outputTokens / 1,000,000 × outputPrice)
```

Built-in prices include: OpenAI GPT-5.4 / GPT-5.4-mini, Anthropic Claude Sonnet 4.5 / Opus 4, Google Gemini 3.1 Flash, DeepSeek V3, and more. Prices are updated with each clawprobe release.

> **Note**: If your model is not in the price table, clawprobe will display token counts but show cost as `n/a`. You can add custom prices in `~/.clawprobe/config.json` — see [Configuration](#11-configuration).

### Cost alerts

Set a daily budget in your config and clawprobe will alert you when you're approaching it:

```json
// ~/.clawprobe/config.json
{
  "alerts": {
    "dailyBudgetUsd": 5.00
  }
}
```

The `suggest` command will show a warning when today's cost exceeds 80% of your budget.

---

## 5. Tracking a Single Session's Cost

### What is a "session"?

In OpenClaw, a **session** corresponds to a single conversation window — one `clawprobe start` to `exit`. Each session has its own `.jsonl` transcript file and a `sessionKey` (e.g., `sess_abc123`). Sessions accumulate token counts independently.

### List all sessions

```bash
clawprobe session --list
```

```
📋 Sessions  [agent: main]

  Session Key      Model                  Tokens (in/out)    Cost      Last Active
  ────────────     ──────────────────     ───────────────    ──────    ──────────────
  sess_abc123  ●  claude-sonnet-4.5      41,200 / 11,800   $3.21     Today 14:31
  sess_9de812      claude-sonnet-4.5      88,400 / 24,100   $6.74     Yesterday 22:15
  sess_7fb001      gpt-5.4-mini          210,000 / 61,000   $1.14     Mar 14
  sess_3ca990      claude-sonnet-4.5     134,800 / 38,200   $9.87     Mar 12
  sess_1ab445      claude-opus-4          52,000 / 15,000  $23.85     Mar 10

  ● = currently active
  5 sessions total  |  All time: $44.81
```

### View a single session's full breakdown

```bash
clawprobe session sess_abc123
```

```
📊 Session: sess_abc123

  Agent:       main
  Model:       claude-sonnet-4.5
  Started:     Today 09:12
  Last active: Today 14:31  (5h 19min)
  Compactions: 2

  ─────────────────────────────────────────────
  Token usage:
    Input:   41,200 tokens    $1.44
    Output:  11,800 tokens    $1.77
    Total:   53,000 tokens    $3.21
  ─────────────────────────────────────────────

  Turn-by-turn cost timeline:

    Turn  1  09:12   +2,100 in /   +380 out   $0.037
    Turn  2  09:18   +3,200 in /   +510 out   $0.058
    Turn  3  09:25  +18,200 in /   +920 out   $0.341  ← compact #1 (context rebuilt)
    Turn  4  09:31   +2,400 in /   +290 out   $0.044
    Turn  5  09:44   +3,800 in /   +760 out   $0.076
    Turn  6  10:02   +2,900 in /   +430 out   $0.054
    Turn  7  10:18  +14,100 in /   +840 out   $0.266  ← compact #2
    Turn  8  11:05   +1,800 in /   +390 out   $0.035
    Turn  9  12:30   +2,200 in /   +490 out   $0.041
    Turn 10  14:31   +3,500 in /   +680 out   $0.063

    Avg per turn: $0.102  |  Costliest turn: Turn 3 ($0.341)
    Compact turns consume 3-5× more input tokens (context rebuild)
  ─────────────────────────────────────────────

  Compact events:
    #1  09:25  11 msgs compacted → 18,200 input tokens in this turn
    #2  10:18   8 msgs compacted → 14,100 input tokens in this turn
```

The "compact turns" show why compaction spikes cost: when OpenClaw compacts and rebuilds context, it re-injects all workspace files + the new summary, causing a large input-token burst in that turn.

### Find your current session key

```bash
clawprobe status --json | grep sessionKey
# or just:
clawprobe status
# The session key appears in the output header
```

### View the active session's cost (shorthand)

```bash
clawprobe session
# Without arguments, targets the currently active session
```

### Important: clawprobe must be running to capture turn granularity

Turn-level timeline is built from **snapshots** clawprobe takes every time `sessions.json` updates (after each turn). If clawprobe's daemon was not running during part of the session, those turns are merged into a single `[clawprobe was offline]` gap entry:

```
    Turn  1  09:12   +2,100 in /   +380 out   $0.037
    Turn  2  09:18   +3,200 in /   +510 out   $0.058
    ···      [clawprobe offline 09:20 → 11:00]
    Turn  7  11:05  +31,400 in /  +2,100 out  $1.583  (multiple turns merged)
```

The **total session cost** is always accurate (read from the latest `sessions.json`), only the per-turn breakdown may have gaps.

---

## 6. Tracking Compact Events

### What is a compact event?

When your conversation context gets too large, OpenClaw automatically "compacts" it — it summarizes the old messages and replaces them with a shorter summary. This is necessary to stay within the model's token window, but it means **some context is silently lost**.

clawprobe detects every compact event from the `.jsonl` transcript files and shows you exactly what was compacted.

### View recent compactions

```bash
clawprobe compacts
```

```
📦 Compact Events (last 5)

──────────────────────────────────────────
  #3  Today 14:22  [sess_abc123]
  
  14 messages compacted (Turn 3 → Turn 16)
  Tokens before: 38,450
  
  Compacted messages:
    Turn  3  👤 "This project uses PostgreSQL, not MySQL"
    Turn  5  🤖 "I'll use the Prisma schema you shared..."
    Turn  7  👤 "API responses must use snake_case, not camelCase"
    Turn 10  🤖 "Understood. I'll apply snake_case throughout..."
    Turn 12  👤 "Don't use try/catch inside loop bodies"
    ... and 9 more messages
  
  Summary generated:
    "User is building a TypeScript backend API. They are using
     PostgreSQL with Prisma. We have set up basic CRUD endpoints..."
  
  ⚠ Potentially missing from summary:
    • Database: PostgreSQL (not MySQL) — preference not mentioned
    • API format: snake_case — format preference not mentioned  
    • Code style: avoid try/catch in loops — constraint not mentioned
  
  → Save these to memory: clawprobe memory save-compact 3

──────────────────────────────────────────
  #2  Yesterday 22:15  [sess_abc123]
  
  8 messages compacted (Turn 1 → Turn 8)
  Tokens before: 31,200
  Summary seems adequate.
  
──────────────────────────────────────────
```

### Show more or fewer events

```bash
clawprobe compacts --last 10     # Show last 10
clawprobe compacts --last 3      # Show last 3 (faster)
```

### Show full message content

By default, clawprobe shows a preview. Use `--show-messages` to see full content:

```bash
clawprobe compacts --last 1 --show-messages
```

### Filter by session

```bash
clawprobe compacts --session sess_abc123
```

### Save compacted messages to long-term memory

When clawprobe detects that important content was lost in a compact event, you can save it to `MEMORY.md` with one command:

```bash
clawprobe memory save-compact 3
```

This appends the detected "potentially lost" items to your `MEMORY.md` file, where they'll be included in future sessions. You can also choose a different target file:

```bash
clawprobe memory save-compact 3 --file workspace/memory/2026-03-17.md
```

### How clawprobe detects "important losses"

clawprobe compares the compacted messages against the generated summary. Content is flagged as potentially important if it contains:

- **Preference statements**: "use X", "prefer Y", "don't do Z", "always/never"
- **Technical decisions**: File paths, variable names, config values, library names
- **Named entities**: Project names, service names, tool names
- **Explicit constraints**: "must", "required", "not allowed"

This is heuristic — not every flagged item is critical, and some important items may not be flagged. Use your judgment when reviewing.

---

## 7. Managing Memory

clawprobe provides a full-featured memory browser and editor on top of OpenClaw's `MEMORY.md` and `memory/YYYY-MM-DD.md` files.

### List all memory entries

```bash
clawprobe memory list
```

```
🧠 Long-term Memory  (MEMORY.md)

  1   Prefer PostgreSQL over MySQL for all projects
  2   API response format: snake_case (not camelCase)
  3   TypeScript: strict mode enabled, no implicit any
  4   Docker: use multi-stage builds, Alpine base images
  5   Code review: always run tests before creating PRs
  6   SSH key fingerprint: 3a:8b:c2:... (work laptop)

  6 entries  |  912 chars  |  ~228 tokens
```

List daily notes:

```bash
clawprobe memory list --file workspace/memory/2026-03-17.md
```

### Search memory

```bash
clawprobe memory search "database"
```

```
🔍 3 results for "database"

  1.  MEMORY.md:1  (score: 0.94)
      "Prefer PostgreSQL over MySQL for all projects"

  2.  memory/2026-03-10.md:8  (score: 0.82)
      "Prisma ORM for migrations. Scripts in src/migrations/"

  3.  memory/2026-03-08.md:3  (score: 0.71)
      "Redis caching layer. Config in .env, REDIS_URL key"
```

Search uses OpenClaw's local SQLite FTS5 index — no internet connection required.

### Add to memory

```bash
clawprobe memory add "API pagination: default 20 items per page, max 100"
```

```
✅ Added to MEMORY.md (entry #7)
```

Add to a specific file:

```bash
clawprobe memory add "Meeting notes: backend refactor planned for Q2" \
  --file workspace/memory/2026-03-17.md
```

### Edit a memory entry

```bash
clawprobe memory edit 3
```

This opens your default `$EDITOR` with the entry content. Save and close to update.

Or supply content directly:

```bash
clawprobe memory edit 3 "TypeScript: strict mode + no implicit any + no unused vars"
```

### Delete a memory entry

```bash
clawprobe memory delete 3
```

```
⚠ About to delete entry #3:
  "TypeScript: strict mode enabled, no implicit any"

Confirm? [y/N]: y
✅ Deleted entry #3
```

### Save a compacted message to memory

See [Tracking Compact Events → Save compacted messages](#save-compacted-messages-to-long-term-memory).

### How memory edits work

When you add, edit, or delete memory entries, clawprobe writes directly to the Markdown file. OpenClaw monitors these files with its own file watcher and will pick up changes automatically — no restart needed.

Each entry in `MEMORY.md` is stored as a list item:

```markdown
- Prefer PostgreSQL over MySQL for all projects
- API response format: snake_case (not camelCase)
- TypeScript: strict mode enabled, no implicit any
```

clawprobe maintains this format to stay compatible with OpenClaw's parser.

---

## 8. Context Analysis

### View context breakdown

```bash
clawprobe context
```

```
🔍 Context Analysis  [agent: main]

  Workspace files (injected at session start):
  ┌─────────────────┬──────────────┬───────────────┬───────────┐
  │ File            │ Raw size     │ Injected      │ Status    │
  ├─────────────────┼──────────────┼───────────────┼───────────┤
  │ SOUL.md         │   912 chars  │   912 chars   │ ✓ ok      │
  │ AGENTS.md       │ 1,742 chars  │ 1,742 chars   │ ✓ ok      │
  │ TOOLS.md        │ 54,210 chars │ 20,000 chars  │ ⚠ TRUNC   │
  │ USER.md         │   388 chars  │   388 chars   │ ✓ ok      │
  │ IDENTITY.md     │   294 chars  │   294 chars   │ ✓ ok      │
  │ MEMORY.md       │   912 chars  │   912 chars   │ ✓ ok      │
  └─────────────────┴──────────────┴───────────────┴───────────┘

  TOOLS.md is truncated: 34,210 chars (63%) are never seen by the model

  Token estimates:
  ┌────────────────────────────────────┬───────────────┐
  │ Source                             │ Estimate      │
  ├────────────────────────────────────┼───────────────┤
  │ Workspace files (static)           │   ~7,100 tok  │
  │ Context window (from sessions.json)│  31,204 tok   │
  │ Model window                       │ 128,000 tok   │
  │ Remaining headroom                 │  96,796 tok   │
  └────────────────────────────────────┴───────────────┘
```

### Understanding truncation

OpenClaw injects workspace files at session start. By default, each file is capped at **20,000 characters**. If a file exceeds this limit, the excess is silently dropped — the model never sees it.

Common offender: `TOOLS.md`. If you have many tools registered, their descriptions can easily exceed 20,000 chars. clawprobe detects this and tells you exactly how much is being cut.

**How to fix TOOLS.md truncation:**

Option 1: Split tools into Skills and only load relevant ones per task.  
Option 2: Remove tool descriptions for tools you rarely use.  
Option 3: Increase `bootstrapMaxChars` in `openclaw.json` (also increases base context cost).

```json
// openclaw.json
{
  "agents": {
    "defaults": {
      "bootstrapMaxChars": 30000
    }
  }
}
```

---

## 9. Optimization Suggestions

clawprobe continuously analyzes your agent's behavior and flags issues.

```bash
clawprobe suggest
```

```
💡 Optimization Suggestions  [agent: main]

  ────────────────────────────────────────────────
  🔴 CRITICAL  TOOLS.md has been truncated for 7 consecutive days
  
  34,210 chars (63%) of your TOOLS.md never reach the model.
  Estimated wasted cost: ~$2.10/week
  
  Action: Split TOOLS.md into per-task Skill files
  ────────────────────────────────────────────────
  
  🟡 WARNING   Compaction frequency is high (avg 32 min)
  
  Your context compacts every 32 minutes on average.
  This means frequent context loss and recovery overhead.
  Current reserveTokens: 16,384
  
  Action: Increase reserveTokens to 24,000 in openclaw.json
  ────────────────────────────────────────────────
  
  🔵 INFO      3 workspace files unchanged for 30+ days
  
  IDENTITY.md, HEARTBEAT.md, GLOBAL_AGENTS.md appear stale.
  They still consume context tokens every session.
  
  Action: Review and trim files that are no longer relevant
  ────────────────────────────────────────────────
```

### Filter by severity

```bash
clawprobe suggest --severity critical     # Only critical
clawprobe suggest --severity warning      # Warning and above
```

### Dismiss a suggestion

If a suggestion doesn't apply to your setup, dismiss it:

```bash
clawprobe suggest --dismiss tools-truncation
```

Dismissed suggestions won't reappear. To reset:

```bash
clawprobe suggest --reset-dismissed
```

### Built-in rules

| Rule ID | Severity | Trigger |
|---------|----------|---------|
| `tools-truncation` | Critical | TOOLS.md > 20K chars |
| `high-compact-freq` | Warning | Avg compact interval < 30 min |
| `context-headroom` | Warning | contextTokens > 90% of model window |
| `cost-spike` | Warning | Today's cost > 2× weekly average |
| `budget-80pct` | Warning | Today's cost > 80% of daily budget |
| `stale-workspace-files` | Info | Workspace file unchanged > 30 days |
| `memory-bloat` | Info | MEMORY.md > 50K chars |

---

## 10. Web Dashboard

### Start the dashboard

```bash
clawprobe start
# Dashboard: http://localhost:4747
```

Open `http://localhost:4747` in your browser.

### Dashboard pages

**Overview (`/`)**  
- Active sessions summary card
- Context utilization gauge (gauge shows contextTokens / modelWindow)
- Today vs weekly average cost comparison
- Last 3 compact events
- Active suggestions (critical first)
- Real-time updates via WebSocket

**Cost (`/cost`)**  
- Daily cost bar chart (last 30 days)
- Cost breakdown by token type (input vs output)
- Model breakdown if multiple models used
- Monthly projection

**Compacts (`/compacts`)**  
- Timeline of all compact events, newest first
- Click any event to expand:
  - Full list of compacted messages with role icons
  - Summary text generated by OpenClaw
  - Side-by-side diff: what was in the messages vs what made it into the summary
  - "Save to memory" button for quick rescue

**Context (`/context`)**  
- Workspace file table with raw size, injected size, truncation badges
- Token distribution estimate
- Quick link to fix truncated files

**Memory (`/memory`)**  
- `MEMORY.md` viewer with inline editing
- Calendar view for daily notes
- Semantic search box
- Add / edit / delete entries
- "Last updated" timestamp

**Sessions (`/sessions`)**  
- All sessions table (key, model, provider, tokens, last active)
- Click a session: token trend chart + compact event timeline for that session

### Remote access via SSH tunnel

If clawprobe is running on a remote server:

```bash
ssh -L 4747:localhost:4747 user@your-server
```

Then open `http://localhost:4747` locally.

### Change the port

```bash
clawprobe start --port 5000
# or set in config:
# "server": { "port": 5000 }
```

---

## 11. IM Bot Integration (OpenClaw Skill)

### What this does

Install the clawprobe Skill to let your OpenClaw agent answer questions about its own context, costs, and memory — directly in chat. Works with any messaging app connected to OpenClaw (Telegram, WhatsApp, Slack, WeChat, etc.).

### Install the Skill

```bash
openclaw plugins install @clawprobe/skill
```

This registers clawprobe's tools with your OpenClaw agent. The clawprobe daemon must be running (`clawprobe start`).

### Usage in chat

Type natural language or use shorthand commands:

**Cost queries**

```
You: probe cost
Agent: 💰 This week: $18.42
       Daily avg: $2.63 | Month est: $78.90
       Input: 412K tok ($14.42) | Output: 115K tok ($4.00)
```

```
You: How much have I spent today?
Agent: 💰 Today so far: $3.21
       41,200 input + 11,800 output tokens
       Model: claude-sonnet-4.5
```

**Compact events**

```
You: probe compacts
Agent: 📦 Last 3 compactions:

       #3 Today 14:22 — 14 msgs compacted
       ⚠ Potentially lost: PostgreSQL pref, snake_case format

       #2 Yesterday 22:15 — 8 msgs compacted
       ✓ Summary adequate

       #1 Yesterday 19:41 — 6 msgs compacted
       ✓ Summary adequate
```

```
You: probe save 3
Agent: ✅ Saved compact #3's important content to MEMORY.md:
       • "Prefer PostgreSQL over MySQL"
       • "API format: snake_case"
       • "Avoid try/catch in loop bodies"
```

**Memory management**

```
You: probe memory postgres
Agent: 🔍 Found 2 results:
       1. MEMORY.md: "Prefer PostgreSQL over MySQL for all projects"
       2. memory/2026-03-10.md: "Prisma ORM for migrations"
```

```
You: probe save "Deployment: use GitHub Actions, not CircleCI"
Agent: ✅ Added to MEMORY.md (entry #8)
```

**Status and suggestions**

```
You: probe status
Agent: 📊 Context: 31,204 / 128,000 tokens (24%)
       Today: $3.21 | Session compacts: 3

You: probe suggest
Agent: 💡 1 critical, 1 warning:
       🔴 TOOLS.md truncated (63% lost, ~$2.10/week waste)
       🟡 Compaction too frequent (avg 32 min)
       Run `clawprobe suggest` for details
```

### Full command reference (IM)

| Command | What it does |
|---------|-------------|
| `probe status` | Current session info |
| `probe cost` | This week's API cost |
| `probe cost today` | Today's cost |
| `probe cost month` | This month's cost |
| `probe compacts` | Last 3 compact events |
| `probe compacts last 10` | Last 10 events |
| `probe save <n>` | Save compact event #n to memory |
| `probe memory <query>` | Search memory |
| `probe save "<text>"` | Add text to MEMORY.md |
| `probe suggest` | Optimization suggestions |
| `probe context` | Context window analysis |

---

## 12. Configuration

clawprobe works with zero configuration in most cases. To customize behavior, create `~/.clawprobe/config.json`.

### Full configuration reference

```json
{
  // OpenClaw directory (default: ~/.openclaw)
  "openclaw": {
    "dir": "/path/to/.openclaw",
    "agent": "main"
  },

  // Web server settings
  "server": {
    "port": 4747,
    "host": "127.0.0.1"
  },

  // Cost calculation
  "cost": {
    "customPrices": {
      "my-provider/my-model": {
        "input": 1.50,
        "output": 6.00
      }
    },
    "currency": "USD"
  },

  // Budget alerts
  "alerts": {
    "dailyBudgetUsd": 5.00,
    "weeklyBudgetUsd": 25.00
  },

  // Memory editor settings
  "memory": {
    "defaultFile": "workspace/MEMORY.md",
    "dateFormat": "YYYY-MM-DD"
  },

  // Rule engine
  "rules": {
    "disabled": ["stale-workspace-files"],
    "compactionFreqThresholdMin": 30,
    "memoryBloatThresholdChars": 50000
  }
}
```

### Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENCLAW_DIR` | OpenClaw data directory | `~/.openclaw` |
| `CLAWPROBE_PORT` | Web dashboard port | `4747` |
| `CLAWPROBE_HOST` | Web dashboard host | `127.0.0.1` |
| `CLAWPROBE_DIR` | clawprobe data directory | `~/.clawprobe` |

---

## 13. Troubleshooting

### clawprobe can't find OpenClaw

```
Error: OpenClaw directory not found at ~/.openclaw
```

**Fix**: Set the path manually:

```bash
OPENCLAW_DIR=/custom/path/.openclaw clawprobe status
```

Or add to `~/.clawprobe/config.json`:

```json
{
  "openclaw": {
    "dir": "/custom/path/.openclaw"
  }
}
```

### Token counts look wrong

clawprobe reads from `sessions.json`, which OpenClaw writes after each turn. If OpenClaw hasn't written the file yet, token counts may lag by one turn. Wait a few seconds and run again.

If token counts seem consistently wrong, check if `sessions.json` exists:

```bash
ls ~/.openclaw/agents/main/sessions/sessions.json
```

Some older OpenClaw versions (pre-v2026.1) used a different session store location. Check [OpenClaw release notes](https://github.com/openclaw/openclaw/releases) for migration details.

### Cost shows "n/a"

Your model isn't in clawprobe's price table. Add a custom price:

```json
// ~/.clawprobe/config.json
{
  "cost": {
    "customPrices": {
      "your-provider/your-model": {
        "input": 2.00,
        "output": 8.00
      }
    }
  }
}
```

The `input` and `output` values are USD per 1 million tokens.

### Compact events not showing

clawprobe needs to parse the `.jsonl` transcript files. Check that they exist:

```bash
ls ~/.openclaw/agents/main/sessions/*.jsonl
```

If the files exist but no events appear, try:

```bash
clawprobe compacts --session <your-session-key>
```

You can find your session key in the `sessions.json` file.

### Web dashboard won't open

Check if the daemon is running:

```bash
clawprobe status
```

If it shows `daemon not running`, start it:

```bash
clawprobe start
```

If port 4747 is already in use:

```bash
clawprobe start --port 5000
```

### Memory edits not taking effect

OpenClaw reads workspace files at session start and during context assembly. After editing via clawprobe, the changes will apply in the next context cycle. For immediate effect, start a new session.

If edits are being overwritten, check if another process (or OpenClaw itself) is writing to the same file.

### Permission errors

clawprobe must have read access to `~/.openclaw` and write access to `~/.clawprobe`. Check permissions:

```bash
ls -la ~/.openclaw
ls -la ~/.clawprobe
```

---

## 14. Command Reference

### Global flags

These flags work with all commands:

| Flag | Description |
|------|-------------|
| `--agent <name>` | Target agent (default: `main`) |
| `--json` | Output as JSON (for scripting) |
| `--no-color` | Disable terminal colors |
| `-h, --help` | Show help for command |

### clawprobe start

Start the background daemon and web dashboard.

```
clawprobe start [options]

Options:
  --port <n>          Dashboard port (default: 4747)
  --host <addr>       Dashboard host (default: 127.0.0.1)
  --no-browser        Don't open browser on start
  --daemon-only       Start daemon without web server
```

### clawprobe stop

Stop the running daemon.

```
clawprobe stop
```

### clawprobe status

Show current session status.

```
clawprobe status [options]

Options:
  --agent <name>      Target agent (default: main)
  --session <key>     Target session key
  --json              JSON output
```

### clawprobe cost

Show API cost breakdown.

```
clawprobe cost [options]

Options:
  --day               Today only
  --week              Current week (default)
  --month             Current month
  --all               All time
  --agent <name>      Target agent
  --json              JSON output
```

### clawprobe compacts

Show compact events and optionally archive compacted messages.

```
clawprobe compacts [options]

Options:
  --last <n>          Number of events to show (default: 5)
  --agent <name>      Target agent
  --session <key>     Target session
  --show-messages     Show full message content
  --save <id>         Save compacted messages from event <id> to a memory file
  --file <path>       Target file for --save (default: MEMORY.md in workspace)
  --json              JSON output
```

**Example:**

```bash
clawprobe compacts --save 3                              # Save to MEMORY.md
clawprobe compacts --save 3 --file notes/archive.md     # Save to custom file
```

### clawprobe memory (removed)

The standalone `memory` subcommand has been removed. Use `clawprobe compacts --save <id>` to archive compacted messages to a memory file.

```
# Old: clawprobe memory add <content>
# Use: edit MEMORY.md directly in your workspace

# Old: clawprobe memory list
# Use: clawprobe memory add <content> — edit MEMORY.md directly
  --agent <name>      Target agent

clawprobe memory edit <entry-id> [content] [options]
  --file <path>       Target file
  --agent <name>      Target agent
  (if content omitted, opens $EDITOR)

clawprobe memory delete <entry-id> [options]
  --file <path>       Target file
  --agent <name>      Target agent
  --yes               Skip confirmation

clawprobe memory save-compact <compact-id> [options]
  --file <path>       Target file (default: MEMORY.md)
  --agent <name>      Target agent
```

### clawprobe session

Show per-session cost breakdown, turn timeline, tool usage, todo progress, and sub-agents.

```
clawprobe session [session-key] [options]

Arguments:
  session-key         Session to inspect (default: currently active session)

Options:
  --list              List all sessions (shows human-readable names when available)
  --full              Show full session keys in list (no truncation)
  --turns             Show turn-by-turn cost timeline (default: true)
  --no-turns          Hide turn timeline (summary only)
  --todos             Show todo list section (default: true)
  --no-todos          Hide todo list section
  --agent <name>      Target agent
  --json              JSON output (includes toolStats, todos, agents)
```

**Examples:**

```bash
clawprobe session                    # Active session: turns + tools + todos + sub-agents
clawprobe session --list             # All sessions (human-readable names preferred)
clawprobe session sess_abc123        # Specific session by key
clawprobe session sess_abc123 --json # JSON output for scripting
clawprobe session --no-turns         # Summary only (no turn timeline)
clawprobe session --no-todos         # Hide todo section
```

**JSON output schema:**

```json
{
  "sessionKey": "sess_abc123",
  "agent": "main",
  "model": "claude-sonnet-4.5",
  "startedAt": 1742169120,
  "lastActiveAt": 1742188260,
  "durationMin": 319,
  "inputTokens": 41200,
  "outputTokens": 11800,
  "totalTokens": 53000,
  "estimatedUsd": 3.21,
  "compactionCount": 2,
  "costAccurate": true,
  "turns": [
    {
      "turnIndex": 1,
      "timestamp": 1742169120,
      "inputTokensDelta": 2100,
      "outputTokensDelta": 380,
      "estimatedUsd": 0.037,
      "compactOccurred": false
    }
  ]
}
```

---

### clawprobe context

Show context window analysis.

```
clawprobe context [options]

Options:
  --agent <name>      Target agent
  --json              JSON output
```

### clawprobe suggest

Show optimization suggestions.

```
clawprobe suggest [options]

Options:
  --agent <name>           Target agent
  --severity <level>       Filter: critical | warning | info
  --dismiss <rule-id>      Dismiss a suggestion
  --reset-dismissed        Un-dismiss all suggestions
  --json                   JSON output
```

### clawprobe config

Show detected OpenClaw configuration.

```
clawprobe config [options]

Options:
  --json              JSON output
```

### clawprobe version

Show version information.

```
clawprobe version
```

---

*For questions, issues, or contributions, visit [github.com/your-username/clawprobe](https://github.com/your-username/clawprobe)*
