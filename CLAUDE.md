# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

clawprobe is a CLI observability tool for OpenClaw agents. It monitors OpenClaw's files in the background and provides real-time visibility into token usage, API costs, context health, and smart alerts.

## Development Commands

```bash
# Install dependencies
npm install

# Build (TypeScript compilation)
npm run build

# Development with auto-reload
npm run dev

# Run all tests
npm test

# Run a single test file
npx tsx --test test/cost-and-db.test.ts

# Type check without emitting
npm run typecheck

# Lint
npm run lint
```

## Architecture

### Data Flow

1. **Daemon** (`src/daemon.ts`): Background process that watches OpenClaw files using `chokidar`
   - Watches `sessions.json`, `*.jsonl` transcript files, workspace `.md` files, and `openclaw.json`
   - On file changes, processes data and writes to SQLite (`~/.clawprobe/probe.db`)
   - Runs rules engine periodically to detect issues

2. **File Watcher** (`src/core/watcher.ts`): Debounced file change events (300ms), categorizes changes by type

3. **JSONL Parser** (`src/core/jsonl-parser.ts`): Parses OpenClaw transcript files to extract:
   - Per-turn token usage, model info, and compaction events
   - Session name (`slug` / `custom-title` field)
   - Per-tool call statistics (`toolStats`: name, callCount, errorCount)
   - Todo list state (`latestTodos`) from `TodoWrite`/`TaskCreate`/`TaskUpdate` tool calls
   - Sub-agent invocations (`agentStats`) from `Task` tool calls

4. **Session Store** (`src/core/session-store.ts`): Reads `sessions.json` and maps UUID-named `.jsonl` files to human-readable session keys

5. **Database** (`src/core/db.ts`): SQLite with tables:
   - `session_snapshots`: Periodic snapshots of session state from sessions.json
   - `turn_records`: Per-turn cost data (the single source of truth for billing)
   - `compact_events`: Context compaction events with archived messages
   - `file_snapshots`: Workspace file analysis (truncation detection)
   - `suggestions`: Rule-based optimization alerts
   - `tool_stats`: Per-session tool usage counts and error rates
   - `todo_snapshots`: Latest todo list state per session
   - `agent_stats`: Sub-agent invocation records per session

6. **Cost Engine** (`src/engines/cost.ts`): Calculates API costs with provider-specific pricing including cache discounts. Built-in prices for 30+ models (Anthropic, OpenAI, Google, DeepSeek, Moonshot, etc.)

7. **Rule Engine** (`src/engines/rule-engine.ts`): Built-in rules detect:
   - `tools-truncation`: TOOLS.md truncated by bootstrapMaxChars
   - `high-compact-freq`: Compacting too frequently (< 30 min avg)
   - `context-headroom`: Context window > 90% full
   - `cost-spike`: Today's spend > 2× weekly average
   - `memory-bloat`: MEMORY.md too large

### CLI Structure

Commands are in `src/cli/commands/`:
- `status.ts`: Current session snapshot
- `top.ts`: Live dashboard with auto-refresh (SIGWINCH-aware, shows cache read/write)
- `cost.ts`: API cost tracking (day/week/month/all)
- `session.ts`: Per-session breakdown with turn timeline, tool usage, todos, sub-agents
- `context.ts`: Context window composition analysis
- `compacts.ts`: Compaction event history (`--save` supports `--file` override)
- `suggest.ts`: Optimization suggestions
- `schema.ts`: JSON output schemas for agent integration

### Configuration

- User config: `~/.clawprobe/config.json` (auto-created on first run)
- OpenClaw config: `~/.openclaw/openclaw.json` (auto-detected, override with `OPENCLAW_DIR`)
- Default agent: `main` (configurable)

### Key Design Decisions

1. **Zero side effects**: Only reads OpenClaw files, writes only to `~/.clawprobe/`
2. **Per-turn cost recording**: `turn_records` table stores raw token counts with cache breakdown; cost recomputed at query time using live price table
3. **JSON mode**: All commands support `--json` for agent/tool integration
4. **Daemon logs**: `~/.clawprobe/daemon.log` for debugging

## Testing

Tests use a fixture pattern (`test/helpers.ts`) that creates isolated temp directories:
- `createFixture()`: Sets up mock OpenClaw directory structure
- `runCli()`: Spawns CLI process with `HOME` env var pointed at temp dir
- `cleanupFixture()`: Removes temp dir and resets DB handle

## Node.js Requirements

- Node.js >= 22 (uses `node:sqlite` which requires Node 22+)
- ES modules only (`"type": "module"` in package.json)
