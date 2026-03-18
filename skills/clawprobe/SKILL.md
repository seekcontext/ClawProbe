---
name: clawprobe
description: Monitor OpenClaw agent health, token usage, API cost, and context window in real time. Use when you need to check your own status, inspect context utilization, estimate API costs, review compaction events, or get optimization suggestions. Provides structured JSON output for programmatic self-monitoring.
metadata: {"openclaw": {"emoji": "🦀", "homepage": "https://github.com/seekcontext/ClawProbe"}}
---

# clawprobe

Real-time observability for OpenClaw agents. Check health, token usage, API cost, context window, and optimization suggestions — all from the CLI.

## Install

```bash
npm install -g clawprobe
clawprobe start
```

## Core commands

| Command | What it does |
|---------|-------------|
| `clawprobe status --json` | Full health snapshot (session, model, context %, cost, alerts) |
| `clawprobe cost --week --json` | API cost breakdown for the past week |
| `clawprobe session --json` | Current session token timeline, turn by turn |
| `clawprobe context --json` | Context window utilization and truncation warnings |
| `clawprobe suggest --json` | Active optimization alerts with `ruleId` and `action` |
| `clawprobe compacts --json` | List recent compaction events and lost content |
| `clawprobe top` | Live auto-refreshing dashboard (human use) |

## Recommended self-check workflow

Run at session start or before any expensive task:

```bash
STATUS=$(clawprobe status --json)
UTIL=$(echo $STATUS | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).utilizationPct))")
echo "Context: $UTIL%"
```

Or in a single call:

```bash
clawprobe status --json
```

Key fields to act on:

- `utilizationPct` ≥ 85 → compact soon or start a fresh session
- `suggestions[].ruleId === "tools-truncation"` → TOOLS.md is being cut off
- `suggestions[].ruleId === "cost-spike"` → today's spend is unusually high
- `daemonRunning: false` → run `clawprobe start` to enable monitoring

## Handling suggestions programmatically

```bash
# List active suggestions
clawprobe suggest --json

# Dismiss a noisy rule
clawprobe suggest --dismiss memory-bloat --json
# → { "ok": true, "dismissed": "memory-bloat" }
```

## Schema introspection

When you need to know exact field names for any command:

```bash
clawprobe schema status    # full field spec for status --json
clawprobe schema cost      # full field spec for cost --json
clawprobe schema           # list all available schemas
```

## Error format

All errors under `--json` are structured — never colored text:

```json
{ "ok": false, "error": "no_active_session", "message": "No active session found" }
```

Exit code is always `1` on error.

## Cost note

Cost figures are estimates based on public model pricing. Verify exact amounts with your model provider's billing dashboard.
