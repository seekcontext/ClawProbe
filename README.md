# clawprobe

**Know exactly what your OpenClaw agent is doing.**

Token usage. API cost. Context health. Smart alerts. All in one place — without touching a single line of OpenClaw's internals.

[![npm](https://img.shields.io/npm/v/clawprobe)](https://www.npmjs.com/package/clawprobe)
[![npm downloads](https://img.shields.io/npm/dm/clawprobe)](https://www.npmjs.com/package/clawprobe)
[![GitHub Stars](https://img.shields.io/github/stars/seekcontext/ClawProbe)](https://github.com/seekcontext/ClawProbe)
[![License](https://img.shields.io/github/license/seekcontext/ClawProbe)](./LICENSE)

[Why clawprobe](#why-clawprobe) •
[Quick Start](#quick-start) •
[Commands](#commands) •
[Agent Integration](#agent-integration) •
[Configuration](#configuration) •
[How It Works](#how-it-works)

---

## Why clawprobe

Your OpenClaw agent lives inside a context window — burning tokens, compacting silently, spending your API budget. But you can't see any of it while it's happening.

clawprobe fixes that. It watches OpenClaw's files in the background and gives you a real-time window into what your agent is actually doing:

| Problem | clawprobe |
|---------|-----------|
| "Is my agent healthy right now?" | `clawprobe status` — one-glance dashboard |
| "Why is context getting compacted so often?" | `clawprobe context` + `clawprobe suggest` |
| "What did the agent forget after compaction?" | `clawprobe compacts` |
| "What is this costing me?" | `clawprobe cost --week` with per-model pricing |
| "What is my TOOLS.md taking up?" | Truncation detection + token estimates |

**No configuration required. Zero side effects. 100% local.**

---

## Quick Start

```bash
npm install -g clawprobe

clawprobe start    # Launch background daemon (auto-detects OpenClaw)
clawprobe status   # Instant dashboard
```

That's it. clawprobe auto-detects your OpenClaw installation at `~/.openclaw`. No API keys, no accounts, no telemetry.

---

## Commands

### `clawprobe status` — Dashboard

Everything you need at a glance: session, model, context utilization, today's cost, and active alerts.

```
$ clawprobe status

📊  Agent Status  (active session)
──────────────────────────────────────────────────
  Agent:       main
  Session:     agent:main:workspace:direct:xxx ●
  Model:       moonshot/kimi-k2.5
  Provider:    moonshot

  Context:   87.3K / 200.0K tokens  ███████░░░  44%
  Input:     72.4K tokens   Output: 5.2K tokens
  Compacts:  2   Last active: Today 16:41

  Today:     $0.12

  ⚠  Context window at 44% capacity
     → Consider starting a fresh session if nearing limit
```

---

### `clawprobe cost` — API Cost Tracking

Per-model pricing for 30+ models built-in. Tracks input, output, and cache tokens separately. Day, week, month, or all-time views.

```
$ clawprobe cost --week

💰  Weekly Cost  2026-03-12 – 2026-03-18
──────────────────────────────────────────────────
  Total:     $0.67
  Daily avg: $0.096
  Month est: $2.87

  2026-03-12  ██████████████░░  $0.15
  2026-03-16  ████████████████  $0.16
  2026-03-17  █░░░░░░░░░░░░░░░  $0.0088
  2026-03-18  ███░░░░░░░░░░░░░  $0.03

  Input:   1.0M tokens  $0.65  (97%)
  Output:  47.8K tokens  $0.03  (3%)

  Costs are estimates based on public pricing.
  Verify with your provider's billing dashboard.
```

Built-in prices for: OpenAI (GPT-4o, o1, o3, o4-mini), Anthropic (Claude 3/3.5/3.7 Sonnet/Opus/Haiku), Google (Gemini 2.0/2.5 Flash/Pro), Moonshot (kimi-k2.5), DeepSeek (v3, r1), xAI (Grok), and more. Override or add any model via `~/.clawprobe/config.json`.

---

### `clawprobe session` — Session Detail

Per-session breakdown with a turn-by-turn cost and token timeline.

```
$ clawprobe session

💬  Session  agent:main:workspace:…
──────────────────────────────────────────────────
  Model:      moonshot/kimi-k2.5
  Duration:   2h 14m
  Tokens:     In 859.2K  Out 29.8K  Context 87.3K
  Est. cost:  $0.52
  Compacts:   2

  Turn timeline:
  Turn  Time   ΔInput   ΔOutput  Cost
  1     14:02   4.2K     312     $0.003
  2     14:18  12.7K     891     $0.009  ◆ compact
  3     14:41  38.1K    2.4K     $0.028
  …
```

---

### `clawprobe context` — Context Window Analysis

See what's eating your context window and catch truncation before it silently breaks your agent's tool knowledge.

```
$ clawprobe context

🔍  Context Window  agent: main
──────────────────────────────────────────────────
  Used:    87.3K / 200.0K tokens  ███████░░░  44%

  Workspace overhead:  ~4.2K tokens  (7 injected files)
  Conversation est:    ~83.1K tokens  (messages + system prompt + tools)

  ⚠ TOOLS.md: 31% truncated — model never sees this content
    Run: clawprobe context --json  or increase bootstrapMaxChars in openclaw.json

  Remaining:  112.7K tokens (56%)
```

---

### `clawprobe compacts` — Compaction Events

Every compaction is captured. See what was discarded and archive key context with `--save`.

```
$ clawprobe compacts

📦  Compact Events  last 5
──────────────────────────────────────────────────

  #3  Today 16:22  [agent:main…]  3 messages

    👤  "Can you add retry logic to the upload handler?"
    🤖  "Done — added exponential backoff with 3 retries. The key change is in…"

    → Archive: clawprobe compacts --save 3
```

---

### `clawprobe suggest` — Optimization Alerts

Automatic detection of common issues. Fires only when something actually needs your attention.

| Rule | What It Detects |
|------|----------------|
| `tools-truncation` | TOOLS.md exceeds bootstrap limit — tool descriptions silently cut off |
| `high-compact-freq` | Context fills and compacts too fast (< 30 min intervals) |
| `context-headroom` | Context window > 90% full — compaction imminent |
| `cost-spike` | Today's spend > 2× weekly average |
| `memory-bloat` | MEMORY.md too large — burning tokens every session |

Dismiss noisy rules with `--dismiss <rule-id>`.

---

## Agent Integration

clawprobe is designed to be called **by agents**, not just humans. Every command supports `--json` for clean, parseable output. Errors are always JSON too — never coloured text on stderr.

### One-shot health check

```bash
clawprobe status --json
```

```json
{
  "agent": "main",
  "daemonRunning": true,
  "sessionKey": "agent:main:workspace:direct:xxx",
  "model": "moonshot/kimi-k2.5",
  "sessionTokens": 87340,
  "windowSize": 200000,
  "utilizationPct": 44,
  "todayUsd": 0.12,
  "suggestions": [
    {
      "severity": "warning",
      "ruleId": "context-headroom",
      "title": "Context window at 44% capacity",
      "detail": "...",
      "action": "Consider starting a fresh session or manually compacting now"
    }
  ]
}
```

### Discover the output schema

```bash
clawprobe schema           # List all commands with descriptions
clawprobe schema status    # Full field-by-field spec for status --json
clawprobe schema cost      # Field spec for cost --json
```

### Dismiss a suggestion from a script

```bash
clawprobe suggest --dismiss context-headroom --json
# → { "ok": true, "dismissed": "context-headroom" }
```

### Error responses are always parseable

```bash
clawprobe session --json   # when no session is active
# → { "ok": false, "error": "no_active_session", "message": "..." }
# exit code 1
```

---

## Configuration

Optional config at `~/.clawprobe/config.json` (auto-created on first `clawprobe start`):

```json
{
  "timezone": "Asia/Shanghai",
  "openclaw": {
    "dir": "~/.openclaw",
    "agent": "main"
  },
  "cost": {
    "customPrices": {
      "my-custom-model": { "input": 1.00, "output": 3.00 }
    }
  },
  "alerts": {
    "dailyBudgetUsd": 5.00
  },
  "rules": {
    "disabled": ["memory-bloat"],
    "compactionFreqThresholdMin": 30,
    "memoryBloatThresholdChars": 20000
  }
}
```

Most users need zero configuration. clawprobe auto-detects everything.

---

## How It Works

clawprobe reads OpenClaw's existing data files — no patches, no plugins, no hooks.

```
~/.openclaw/                              clawprobe
──────────────────────────────────        ─────────────────────────────────
sessions.json               →    Session metadata, token counts, model
*.jsonl transcripts         →    Turn-level costs, compact events, usage
workspace/*.md              →    File size analysis, truncation detection
openclaw.json               →    Model config, bootstrap limits
                                          │
                                          ▼
                                ~/.clawprobe/probe.db  (SQLite, local only)
                                          │
                                          ▼
                                 CLI + optimization engine
```

**Why it just works:**

- **Zero configuration** — auto-detects OpenClaw at `~/.openclaw`
- **Zero side effects** — read-only; only writes to its own `~/.clawprobe/` directory
- **Background daemon** — `clawprobe start` launches a watcher with 300ms debounce
- **4 production dependencies** — chokidar, commander, chalk, cli-table3. No cloud, no telemetry.

---

## Compatibility

clawprobe works with any OpenClaw version that writes `sessions.json` and `.jsonl` transcript files to `~/.openclaw/agents/<agent>/sessions/`.

**Requirements:** Node.js ≥ 22 · macOS or Linux (Windows via WSL2)

---

## Privacy

- **100% local** — no data ever leaves your machine
- **No telemetry** — clawprobe collects nothing
- **No accounts, no API keys** — install and run

---

## Contributing

MIT licensed. Contributions welcome.

```bash
git clone https://github.com/seekcontext/ClawProbe
cd ClawProbe && npm install && npm run dev
```

---

[MIT License](./LICENSE)
