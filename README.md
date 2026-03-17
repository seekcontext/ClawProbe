# clawprobe 🦞🔬

**The missing observability layer for OpenClaw**

See what your agent thinks. Track what it forgets. Know what you spend.

```bash
npm install -g clawprobe
clawprobe start
```

---

## Why clawprobe?

OpenClaw users regularly face three problems with no good solution:

**1. Context opacity** — How full is the context window right now? What's eating it? OpenClaw's built-in `/context detail` is useful but not always accessible mid-task.

**2. Silent memory loss** — Compaction silently discards conversation context. Agreed-upon decisions, file paths, preferences — gone without notice.

**3. Memory is a black box** — What does your agent actually remember? Editing `MEMORY.md` by hand is the only option.

clawprobe addresses all three — without touching a single line of OpenClaw's internals.

---

## How it works

clawprobe reads OpenClaw's existing data files — session transcripts, session store, workspace memory files — and turns them into actionable insights. No code changes, no plugins, no configuration required.

```
OpenClaw data files          clawprobe
─────────────────────        ──────────────────────────────────
sessions.json          →     Session list, token counts
*.jsonl transcripts    →     Accurate context usage, compact events, cost
workspace/*.md files   →     File size analysis, truncation detection
MEMORY.md              →     Memory browser & editor
```

---

## Features

### 📊 Agent Status

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

### 🔍 Context Analysis

Understand how the context window is being used, and catch issues before they cause problems.

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

### 📦 Compact Event Tracking

Every time OpenClaw compacts your session, clawprobe captures what was compacted and lets you save key context to long-term memory.

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

### 💰 Cost Tracking

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

> **Note:** Cost estimates are $0.00 for Kimi/Moonshot because the API
> does not return pricing data in usage responses. Set `customPrices` in
> `~/.clawprobe/config.json` to see accurate estimates.

### 🧠 Memory Browser

Browse, search, edit, and add to your agent's memory — no more hand-editing Markdown.

```
$ clawprobe memory list

$ clawprobe memory search "database"

$ clawprobe memory add "Prefer snake_case for all API responses"
✓ Added to MEMORY.md

$ clawprobe memory save-compact 1
✓ Saved compact summary to MEMORY.md
```

### 💡 Optimization Suggestions

clawprobe automatically detects common issues.

```
$ clawprobe suggest

💡  Optimization Suggestions  agent: main
──────────────────────────────────────────────────

  ✓ No issues detected. Your agent looks healthy.
```

Rules checked:
- `TOOLS.md` truncation (file exceeds bootstrap limit — tools silently cut off)
- High compaction frequency (context fills up too fast)
- High error rate (model returning errors repeatedly)
- Stale workspace files (files unchanged for 30+ days)

---

## Installation

### Requirements

- Node.js ≥ 22
- OpenClaw installed and configured
- macOS or Linux (Windows via WSL2)

### Install

```bash
npm install -g clawprobe
```

### First run

```bash
clawprobe start      # Start background daemon
clawprobe status     # Check active session
```

clawprobe auto-detects your OpenClaw installation at `~/.openclaw`. No configuration needed.

---

## Quick Reference

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

---

## Compatibility

clawprobe works by reading OpenClaw's file system directly. It is compatible with any OpenClaw version that writes `sessions.json` and `.jsonl` transcript files to `~/.openclaw/agents/<agent>/sessions/`.

---

## Privacy

- **100% local** — no data ever leaves your machine
- **Read-only by default** — only writes when you use `memory add`, `memory edit`, `memory delete`, or `memory save-compact`
- **No telemetry** — clawprobe collects nothing
- **No accounts** — no sign-up, no API keys required

---

## Contributing

clawprobe is open source (MIT). Contributions welcome.

```bash
git clone https://github.com/seekcontext/ClawProbe
cd ClawProbe
npm install
npm run dev
```

---

## License

MIT © 2026 clawprobe contributors
