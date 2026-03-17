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

**1. Runaway API costs** — Bills of $22/day to $3,600/month. The built-in `/context detail` command has a known 10x token undercount bug. You're flying blind.

**2. Silent memory loss** — Compaction silently discards conversation context mid-task. Agreed-upon decisions, file paths, preferences — gone. You don't even know what was lost.

**3. Memory is a black box** — What does your agent actually remember? Editing `MEMORY.md` by hand is the only option.

clawprobe fixes all three — without touching a single line of OpenClaw's internals.

---

## How it works

clawprobe reads OpenClaw's existing data files — session transcripts, session store, workspace memory files — and turns them into actionable insights. No code changes, no ContextEngine plugins, no configuration required.

```
OpenClaw data files          clawprobe
─────────────────────        ──────────────────────────────────
sessions.json          →     Accurate token counts & cost tracking
*.jsonl transcripts    →     Compact event detection & diff
workspace/*.md files   →     File size analysis & truncation detection
MEMORY.md              →     Memory browser & editor
memory/*.sqlite        →     Semantic memory search
```

---

## Features

### 💰 Cost Tracking

See exactly where your API budget goes, broken down by day, week, and month.

```
$ clawprobe cost --week

💰 Weekly Cost (Mar 10 – Mar 17, 2026)

  Total:    $18.42
  Daily avg: $2.63
  Month est: $78.90

  Mon  ██████████  $3.21
  Tue  ████████    $2.84
  Wed  ████████████████  $4.12  ← peak
  Thu  ██████      $2.10
  Fri  █████████   $2.95
  Sat  ████        $1.52
  Sun  █████       $1.68

  Input tokens:   412,000 (78%)  $14.42
  Output tokens:  115,000 (22%)   $4.00
```

### 📦 Compact Event Tracking

Every time OpenClaw compacts your session, clawprobe captures exactly what was lost — and lets you save it to long-term memory in one command.

```
$ clawprobe compacts

📦 Compact Events

  #3  Today 14:22
      14 messages compacted (Turn 3 → Turn 16)
      Tokens before: 38,450

      ⚠ Potentially lost:
        Turn 3  👤 "This project uses PostgreSQL, not MySQL"
        Turn 12 👤 "API response format must use snake_case"

      Summary: "User is building a TypeScript backend..."
      → Missing: database choice, API format preference

      [run: clawprobe memory save-compact 3]
```

### 🧠 Memory Browser

Browse, search, edit, and add to your agent's memory — no more hand-editing Markdown.

```
$ clawprobe memory search "database"

🔍 3 results

  1. MEMORY.md:8  (score: 0.92)
     "Database: PostgreSQL. Not MySQL. Team prefers PG advanced features."

  2. memory/2026-03-10.md:15  (score: 0.85)
     "Decided on Prisma ORM for migrations. Scripts in src/migrations/."

  3. memory/2026-03-08.md:3  (score: 0.71)
     "Redis for caching layer. Config in .env."
```

```
$ clawprobe memory add "New requirement: API pagination, default 20 items per page"
✅ Added to MEMORY.md
```

### 🔍 Context Analysis

Understand how your agent's context window is being used, and catch issues before they cost you.

```
$ clawprobe context

🔍 Context Analysis

  Workspace files:
    SOUL.md       912 chars    ~228 tok   ✓ fully injected
    AGENTS.md   1,742 chars    ~436 tok   ✓ fully injected
    TOOLS.md   54,210 chars  ~13,553 tok  ⚠ TRUNCATED → 20,000 chars (~5,000 tok)
    USER.md       388 chars     ~97 tok   ✓ fully injected
    MEMORY.md     912 chars    ~228 tok   ✓ fully injected

  Context tokens (from session):  31,204 / 128,000 (24%)
  Workspace files estimate:        ~7,100 tok (23%)

  ⚠ TOOLS.md: 34,210 chars (63%) are never seen by the model
    → Consider splitting into per-task files or using Skills
```

### 💡 Optimization Suggestions

clawprobe automatically detects common cost and reliability issues.

```
$ clawprobe suggest

💡 Suggestions

  [CRITICAL] TOOLS.md truncated for 7 consecutive days
    34K chars of tool descriptions never reach the model.
    Estimated waste: ~$2.10/week
    → Split TOOLS.md into smaller Skill-specific files

  [WARNING] Compaction frequency is high (avg 32 min interval)
    reserveTokens=16384 may be too low for your workflow.
    → Try: increase to 24000 in openclaw.json

  [INFO] 3 workspace files haven't changed in 30+ days
    IDENTITY.md, HEARTBEAT.md may be safe to trim
```

### 📊 Web Dashboard

A local web UI for deeper visual analysis.

```
$ clawprobe start
Dashboard: http://localhost:4747
```

Pages: Overview · Cost Trends · Compact Timeline · Context · Memory · Sessions

Access remotely via SSH tunnel:
```bash
ssh -L 4747:localhost:4747 user@your-server
```

### 💬 IM Integration (OpenClaw Skill)

Install the clawprobe Skill to interact via Telegram, WhatsApp, or any chat app connected to OpenClaw.

```bash
openclaw plugins install @clawprobe/skill
```

Then in chat:
```
You: probe cost
Agent: 💰 This week: $18.42 (avg $2.63/day, est $78.90/month)

You: probe compacts
Agent: 📦 Last compact: 14:22 today. 14 messages compacted.
       ⚠ Lost: PostgreSQL preference, snake_case API format
       → Reply "probe save 3" to save to long-term memory

You: probe suggest
Agent: 💡 TOOLS.md truncated (CRITICAL) — wasting ~$2.10/week
       reserveTokens may be too low (WARNING)
```

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
clawprobe start
```

clawprobe auto-detects your OpenClaw installation at `~/.openclaw`. No configuration needed.

---

## Quick Reference

```bash
# Status
clawprobe status              # Current session info
clawprobe context             # Context window breakdown

# Cost
clawprobe cost                # This week
clawprobe cost --day          # Today
clawprobe cost --month        # This month

# Compact events
clawprobe compacts            # Last 5 events
clawprobe compacts --last 10  # Last 10 events

# Memory
clawprobe memory list                        # List all long-term memory
clawprobe memory search "postgres"           # Search memory
clawprobe memory add "prefer snake_case"     # Add to memory
clawprobe memory save-compact 3              # Save from compact event #3

# Suggestions
clawprobe suggest             # Show all suggestions

# Dashboard
clawprobe start               # Start daemon + web UI at :4747
clawprobe stop                # Stop daemon
```

---

## Compatibility

| ContextEngine Plugin | Compatible |
|----------------------|-----------|
| LegacyContextEngine (default) | ✅ |
| lossless-claw | ✅ |
| OpenViking Plugin | ✅ |
| MemOS Cloud Plugin | ✅ |
| ClawVault | ✅ |
| Any other plugin | ✅ |

clawprobe works by reading OpenClaw's file system, not by hooking into the ContextEngine. It is compatible with any plugin configuration.

---

## Privacy

- **100% local** — no data ever leaves your machine
- **Read-only by default** — only writes when you explicitly use `memory add`, `memory edit`, `memory delete`, or `memory save-compact`
- **No telemetry** — clawprobe collects nothing
- **No accounts** — no sign-up, no API keys required

---

## Contributing

clawprobe is open source (MIT). Contributions welcome.

```bash
git clone https://github.com/your-username/clawprobe
cd clawprobe
npm install
npm run dev
```

See [DESIGN.md](./DESIGN.md) for architecture details.

---

## License

MIT © 2026 clawprobe contributors
