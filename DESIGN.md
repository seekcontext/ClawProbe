# clawprobe — Technical Design Document

> Version: 0.1.0-draft  
> Last Updated: 2026-03-17

---

## 1. Overview

clawprobe is a local-first observability and management tool for OpenClaw AI agents. It reads OpenClaw's existing data files (session transcripts, session store, workspace memory files) without modifying any OpenClaw internals, and provides:

- A CLI for headless/ECS environments
- A local Web Dashboard for visual analysis
- An OpenClaw Skill for in-chat IM interaction

### Design Principles

1. **Zero configuration** — auto-detects OpenClaw's data directory
2. **Zero side effects** — read-only by default; writes only to OpenClaw's Markdown memory files (which OpenClaw itself manages)
3. **Local first** — no cloud, no telemetry, no accounts
4. **Engine agnostic** — works regardless of which ContextEngine plugin is installed
5. **Progressive disclosure** — CLI gives instant answers; Dashboard gives deep analysis

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        OpenClaw Process                          │
│                                                                  │
│  ~/.openclaw/                                                    │
│  ├── openclaw.json              (config)                         │
│  ├── workspace/                 (agent workspace)                │
│  │   ├── SOUL.md                                                 │
│  │   ├── AGENTS.md                                               │
│  │   ├── TOOLS.md                                                │
│  │   ├── USER.md                                                 │
│  │   ├── IDENTITY.md                                             │
│  │   ├── MEMORY.md              (long-term memory)               │
│  │   └── memory/YYYY-MM-DD.md  (daily notes)                    │
│  ├── agents/<agent>/sessions/                                    │
│  │   ├── sessions.json          (token counts, metadata)         │
│  │   └── <sessionKey>.jsonl     (append-only transcript)         │
│  └── memory/<agentId>.sqlite    (memory search index)            │
└──────────────────────────┬──────────────────────────────────────┘
                           │  fs.watch (chokidar)
                           │  file reads (no modification)
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                    clawprobe Core (Node.js)                      │
│                                                                  │
│  ┌─────────────────┐  ┌──────────────────┐  ┌───────────────┐  │
│  │  File Watchers  │  │   Data Parsers   │  │  Analyzers    │  │
│  │                 │  │                  │  │               │  │
│  │  chokidar       │  │  JsonlParser     │  │  CostEngine   │  │
│  │  sessions.json  │  │  SessionStore    │  │  CompactDiff  │  │
│  │  *.jsonl        │  │  ConfigReader    │  │  FileSizeEst  │  │
│  │  memory/*.md    │  │  MarkdownReader  │  │  RuleEngine   │  │
│  └────────┬────────┘  └────────┬─────────┘  └───────┬───────┘  │
│           │                   │                     │           │
│           └───────────────────┴─────────────────────┘           │
│                               │                                  │
│                    ┌──────────▼──────────┐                      │
│                    │   clawprobe SQLite   │                      │
│                    │   (~/.clawprobe/     │                      │
│                    │    probe.db)         │                      │
│                    └──────────┬──────────┘                      │
│                               │                                  │
│              ┌────────────────┼────────────────┐                │
│              ▼                ▼                ▼                │
│         ┌─────────┐    ┌──────────┐    ┌───────────┐           │
│         │   CLI   │    │  HTTP    │    │  OpenClaw │           │
│         │         │    │  Server  │    │  Skill    │           │
│         │ clawprobe│   │ :4747    │    │  (IM bot) │           │
│         └─────────┘    └──────────┘    └───────────┘           │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. Data Sources & Parsing

### 3.1 sessions.json

**Location**: `~/.openclaw/agents/<agent>/sessions/sessions.json`

**Key fields extracted**:

```typescript
interface SessionEntry {
  sessionId: string;
  updatedAt: number;              // last activity timestamp
  inputTokens: number;            // cumulative input tokens
  outputTokens: number;           // cumulative output tokens
  totalTokens: number;            // input + output
  contextTokens: number;          // current context window usage
  compactionCount: number;        // how many times compact ran
  memoryFlushAt?: number;         // last pre-compact memory flush
  modelOverride?: string;         // model in use
  providerOverride?: string;      // provider in use
}
```

**Usage**: Session metadata, token counts, compaction frequency, model detection.

### 3.1.1 Session-level Cost Calculation

`sessions.json` stores **cumulative** token counts for the lifetime of a session. To calculate the cost of a **single session** (conversation), clawprobe uses snapshot diffing:

```typescript
interface SessionSnapshot {
  sessionKey: string;
  inputTokens: number;
  outputTokens: number;
  sampledAt: number;  // unix timestamp
}

function calcSessionCost(sessionKey: string): SessionCost {
  // Fetch the two bounding snapshots from probe.db:
  // - earliest snapshot for this sessionKey (session start baseline)
  // - latest snapshot (current state)
  const first = db.get(
    `SELECT * FROM session_snapshots WHERE session_key = ? ORDER BY sampled_at ASC LIMIT 1`,
    sessionKey
  );
  const last = db.get(
    `SELECT * FROM session_snapshots WHERE session_key = ? ORDER BY sampled_at DESC LIMIT 1`,
    sessionKey
  );

  return {
    sessionKey,
    model: last.model,
    inputTokens:  last.input_tokens  - first.input_tokens,
    outputTokens: last.output_tokens - first.output_tokens,
    totalTokens:  (last.input_tokens + last.output_tokens) - (first.input_tokens + first.output_tokens),
    estimatedUsd: costEngine.estimate(deltaInput, deltaOutput, last.model),
    startedAt: first.sampled_at,
    lastActiveAt: last.sampled_at,
    durationMin: Math.round((last.sampled_at - first.sampled_at) / 60),
    compactionCount: last.compaction_count,
  };
}
```

**Why snapshot diff works**: When a session starts, clawprobe writes the first snapshot (tokens = 0 or carry-over from prior compaction). Every time `sessions.json` updates, a new snapshot is written. The delta between first and last snapshot gives the cost attributable to that session.

**Limitation**: If clawprobe was not running when the session started, the earliest snapshot may not capture the true session start. In that case, clawprobe shows a note: `"Cost may be understated (clawprobe was not running at session start)"`.

**Turn-level granularity**: Each snapshot in `session_snapshots` is timestamped. clawprobe can show a **turn-by-turn cost timeline** by computing deltas between consecutive snapshots within a session.

```
Turn  1  09:14   +2,100 input / +380 output   $0.037
Turn  2  09:18   +3,200 input / +510 output   $0.058
Turn  3  09:25  +18,200 input / +920 output   $0.341  ← large (compact occurred)
Turn  4  09:31   +2,400 input / +290 output   $0.044
```

A large input-token spike correlates with a compact event (context was rebuilt from summary, re-injecting workspace files + history).

---

### 3.2 \<sessionKey\>.jsonl

**Location**: `~/.openclaw/agents/<agent>/sessions/<sessionKey>.jsonl`

**Format**: JSON Lines, append-only, tree structure via `id` + `parentId`.

**Entry types and fields**:

```typescript
// Session header (first line)
interface SessionHeader {
  type: "session";
  id: string;
  cwd: string;
  timestamp: number;
  parentSession?: string;
}

// Conversation message
interface MessageEntry {
  type: "message";
  id: string;
  parentId: string;
  role: "user" | "assistant" | "tool";
  content: string;
  timestamp?: number;
}

// Compaction event — KEY for compact tracking
interface CompactionEntry {
  type: "compaction";
  id: string;
  parentId: string;
  firstKeptEntryId: string;   // entries before this were compacted
  tokensBefore: number;        // context size before compact
  content: string;             // the summary text
  timestamp?: number;
}

// Custom injected message (memory recall, etc.)
interface CustomMessageEntry {
  type: "custom_message";
  id: string;
  parentId: string;
  role: string;
  content: string;
  hidden?: boolean;
}
```

**Compact diff algorithm**:

```
1. Parse all entries from .jsonl file
2. Find all `compaction` entries, sorted by position
3. For each compaction entry:
   a. Collect all `message` entries with id < firstKeptEntryId
      that appeared after the previous compaction's firstKeptEntryId
   b. These are the "compacted messages" for this event
   c. Compare them against the compaction summary (content field)
   d. Identify important content absent from the summary
4. Store results in probe.db for querying
```

### 3.3 Workspace Files

**Location**: `~/.openclaw/workspace/` (default, configurable via `agents.defaults.workspace`)

**Files monitored**:

| File | Purpose | clawprobe usage |
|------|---------|----------------|
| `SOUL.md` | Agent personality | Size tracking, truncation detection |
| `AGENTS.md` | Behavior rules | Size tracking |
| `TOOLS.md` | Tool descriptions | Size + truncation (20K char limit) |
| `USER.md` | User info | Size tracking |
| `IDENTITY.md` | Agent identity | Size tracking |
| `MEMORY.md` | Long-term memory | Read + write (memory management) |
| `memory/YYYY-MM-DD.md` | Daily notes | Read + write (memory management) |

**Truncation detection**:

```typescript
const BOOTSTRAP_MAX_CHARS = 20000; // openclaw default

function detectTruncation(file: WorkspaceFile): TruncationStatus {
  const rawChars = file.content.length;
  const injectedChars = Math.min(rawChars, BOOTSTRAP_MAX_CHARS);
  const wasTruncated = rawChars > BOOTSTRAP_MAX_CHARS;
  const lostChars = rawChars - injectedChars;
  const lostPercent = (lostChars / rawChars) * 100;
  return { wasTruncated, rawChars, injectedChars, lostChars, lostPercent };
}
```

**Config override**: If `agents.defaults.bootstrapMaxChars` is set in `openclaw.json`, use that value.

### 3.4 openclaw.json

**Location**: `~/.openclaw/openclaw.json`

**Key fields extracted**:

```typescript
interface OpenClawConfig {
  agents?: {
    defaults?: {
      workspace?: string;
      bootstrapMaxChars?: number;
      compaction?: {
        reserveTokens?: number;
        keepRecentTokens?: number;
      };
    };
  };
  plugins?: {
    slots?: {
      contextEngine?: string;
      memory?: string;
    };
  };
  models?: {
    default?: string;
    provider?: string;
  };
}
```

### 3.5 memory/\<agentId\>.sqlite (read-only)

**Location**: `~/.openclaw/memory/<agentId>.sqlite`

**Usage**: Query for memory search (FTS5 full-text search). clawprobe opens this in read-only mode (`SQLITE_OPEN_READONLY`) to avoid any write conflicts with OpenClaw.

```sql
-- clawprobe uses OpenClaw's own FTS5 index
SELECT snippet, path, line_start, line_end, score
FROM memory_fts
WHERE memory_fts MATCH ?
ORDER BY rank
LIMIT 10;
```

---

## 4. clawprobe SQLite Schema

clawprobe maintains its own analysis database at `~/.clawprobe/probe.db`.

```sql
-- Session snapshots (one per sessions.json update)
CREATE TABLE session_snapshots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent       TEXT NOT NULL,
  session_key TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  model       TEXT,
  provider    TEXT,
  input_tokens   INTEGER,
  output_tokens  INTEGER,
  total_tokens   INTEGER,
  context_tokens INTEGER,
  compaction_count INTEGER,
  sampled_at  INTEGER NOT NULL  -- unix timestamp
);

-- Cost records (computed from session_snapshots)
CREATE TABLE cost_records (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent       TEXT NOT NULL,
  session_key TEXT NOT NULL,
  date        TEXT NOT NULL,    -- YYYY-MM-DD
  input_tokens   INTEGER,
  output_tokens  INTEGER,
  model       TEXT,
  estimated_usd  REAL,
  recorded_at INTEGER NOT NULL
);

-- Compact events (parsed from .jsonl)
CREATE TABLE compact_events (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  agent                TEXT NOT NULL,
  session_key          TEXT NOT NULL,
  compaction_entry_id  TEXT NOT NULL UNIQUE,
  first_kept_entry_id  TEXT NOT NULL,
  tokens_before        INTEGER,
  summary_text         TEXT,
  compacted_at         INTEGER,
  compacted_message_count INTEGER,
  compacted_messages   TEXT    -- JSON array of {role, content, id}
);

-- File size history
CREATE TABLE file_snapshots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent       TEXT NOT NULL,
  file_path   TEXT NOT NULL,
  raw_chars   INTEGER,
  injected_chars INTEGER,
  was_truncated  INTEGER,  -- boolean
  sampled_at  INTEGER NOT NULL
);

-- Optimization suggestions (computed by RuleEngine)
CREATE TABLE suggestions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent       TEXT NOT NULL,
  rule_id     TEXT NOT NULL,
  severity    TEXT NOT NULL,  -- 'warning' | 'info' | 'critical'
  title       TEXT NOT NULL,
  detail      TEXT NOT NULL,
  action      TEXT,
  created_at  INTEGER NOT NULL,
  dismissed   INTEGER DEFAULT 0
);
```

---

## 5. Module Design

### 5.1 FileWatcher

```typescript
class FileWatcher {
  watch(paths: string[], handler: ChangeHandler): void;
  // Uses chokidar with debounce (500ms) to batch rapid changes
  // Handles file creation, modification, deletion
}
```

### 5.2 JsonlParser

```typescript
class JsonlParser {
  // Incremental parsing — only reads new lines appended since last parse
  // Maintains a cursor (byte offset) per file for efficiency
  parseIncremental(filePath: string): AsyncIterator<JournalEntry>;
  parseAll(filePath: string): Promise<JournalEntry[]>;
  getCompactEvents(entries: JournalEntry[]): CompactEvent[];
  getCompactedMessages(
    entries: JournalEntry[],
    compactEvent: CompactEvent
  ): MessageEntry[];
}
```

### 5.3 CostEngine

```typescript
// Model pricing table (USD per 1M tokens)
const MODEL_PRICES: Record<string, { input: number; output: number }> = {
  "openai/gpt-5.4":           { input: 5.00,  output: 20.00  },
  "openai/gpt-5.4-mini":      { input: 0.30,  output: 1.20   },
  "anthropic/claude-sonnet-4.5":{ input: 3.00, output: 15.00 },
  "anthropic/claude-opus-4":  { input: 15.00, output: 75.00  },
  "google/gemini-3.1-flash":  { input: 0.075, output: 0.30   },
  "deepseek/deepseek-v3":     { input: 0.27,  output: 1.10   },
  // ... expandable
};

class CostEngine {
  estimateCost(tokens: TokenCount, model: string): number;
  getDailyCosts(agent: string, days: number): DailyCost[];
  getWeeklyCost(agent: string): WeeklySummary;
  getMonthlyCost(agent: string): MonthlySummary;
  getCostByCategory(agent: string): CostByCategory;
  // Categories: context_history, workspace_files, tool_results, memory_recall
}
```

### 5.4 CompactDiffEngine

```typescript
class CompactDiffEngine {
  // Core algorithm: compare compacted messages against the summary
  // to identify content that was silently dropped
  analyzeCompaction(event: CompactEvent): CompactAnalysis;
  
  // Heuristic: content is "important" if it contains:
  // - Preference statements ("use X not Y", "prefer X", "don't X")
  // - Technical decisions (file paths, variable names, config values)
  // - Named entities (project names, people names)
  // - Explicit user instructions
  scoreLoss(message: MessageEntry, summary: string): ImportanceScore;
}

interface CompactAnalysis {
  event: CompactEvent;
  compactedMessages: MessageEntry[];
  importantLosses: { message: MessageEntry; score: number; reason: string }[];
  summaryQuality: 'good' | 'partial' | 'poor';
}
```

### 5.5 RuleEngine

```typescript
// Pluggable rule system for generating optimization suggestions
interface Rule {
  id: string;
  name: string;
  check(state: ProbeState): Suggestion | null;
}

const BUILT_IN_RULES: Rule[] = [
  ToolsMdTruncationRule,       // TOOLS.md > 20K chars
  UnusedToolsRule,             // Tool schemas taking tokens but never called
  HighCompactionFrequencyRule, // Compacting too often (< 30 min intervals)
  HeartbeatCostRule,           // Heartbeat consuming significant tokens
  MemoryBloatRule,             // MEMORY.md > threshold
  CostSpikeRule,               // Today's cost > 2x weekly average
  ContextLeakRule,             // contextTokens > 90% of model window
];
```

### 5.6 MemoryEditor

```typescript
class MemoryEditor {
  // Read operations
  listEntries(memoryFile: string): Promise<MemoryEntry[]>;
  search(query: string, agent: string): Promise<SearchResult[]>;
  
  // Write operations (modify OpenClaw's Markdown files)
  addEntry(memoryFile: string, content: string): Promise<void>;
  updateEntry(memoryFile: string, entryId: number, newContent: string): Promise<void>;
  deleteEntry(memoryFile: string, entryId: number): Promise<void>;
  saveCompactedMessage(message: MessageEntry, targetFile: string): Promise<void>;
  
  // OpenClaw will auto-reindex via its file watcher after writes
}
```

---

## 6. CLI Command Reference

### Command Structure

```
clawprobe <command> [subcommand] [options]
```

### Commands

```
clawprobe start              Start the background daemon + web dashboard
clawprobe stop               Stop the daemon
clawprobe status             Current session status (tokens, model, compactions)
clawprobe cost               Cost summary (default: current week)
clawprobe session            Per-session cost and turn breakdown
clawprobe compacts           Recent compaction events
clawprobe memory             Memory management subcommands
clawprobe context            Context composition estimate
clawprobe suggest            Optimization suggestions
clawprobe config             Show detected OpenClaw configuration
clawprobe version            Show clawprobe version
```

### Detailed Options

```
clawprobe status
  --agent <name>     Target agent (default: main)
  --session <key>    Target session key
  --json             Output as JSON

clawprobe cost
  --day              Today
  --week             Current week (default)
  --month            Current month
  --all              All time
  --agent <name>     Target agent
  --json             Output as JSON

clawprobe session
  <session-key>      Show full cost breakdown for a specific session
  --list             List all sessions (sorted by last active)
  --agent <name>     Target agent
  --json             Output as JSON

clawprobe compacts
  --last <n>         Show last N events (default: 5)
  --agent <name>     Target agent
  --session <key>    Target session
  --show-messages    Show full compacted message content
  --json             Output as JSON

clawprobe memory list
  --file <path>      Target memory file (default: MEMORY.md)
  --agent <name>     Target agent

clawprobe memory search <query>
  --agent <name>     Target agent
  --limit <n>        Max results (default: 10)

clawprobe memory add <content>
  --file <path>      Target file (default: MEMORY.md)
  --agent <name>     Target agent

clawprobe memory edit <entry-id>
  --file <path>      Target memory file
  --agent <name>     Target agent

clawprobe memory delete <entry-id>
  --file <path>      Target memory file
  --agent <name>     Target agent

clawprobe memory save-compact <compact-id>
  --file <path>      Target memory file (default: MEMORY.md)
  --agent <name>     Target agent

clawprobe context
  --agent <name>     Target agent
  --json             Output as JSON

clawprobe suggest
  --agent <name>     Target agent
  --severity <level> Filter by severity (critical|warning|info)
  --json             Output as JSON
```

---

## 7. HTTP API

The local server (`http://localhost:4747`) exposes a REST API consumed by the Web Dashboard.

```
GET  /api/status                   Current status for all agents
GET  /api/status/:agent            Status for specific agent
GET  /api/cost?period=week&agent=  Cost data
GET  /api/cost/daily?days=30       Daily cost breakdown
GET  /api/compacts?agent=&last=5   Recent compact events
GET  /api/compacts/:id             Single compact event detail
GET  /api/context?agent=           Context composition estimate
GET  /api/memory/list?agent=       List memory entries
GET  /api/memory/search?q=&agent=  Search memory
POST /api/memory/add               Add memory entry
PUT  /api/memory/:id               Update memory entry
DELETE /api/memory/:id             Delete memory entry
POST /api/memory/save-compact      Save compacted message to memory
GET  /api/suggestions?agent=       Optimization suggestions
POST /api/suggestions/:id/dismiss  Dismiss a suggestion
GET  /api/config                   Detected OpenClaw config
GET  /api/health                   Health check

WebSocket: ws://localhost:4747/ws
  Events: session_update, compact_event, suggestion, file_change
```

---

## 8. Web Dashboard Pages

```
/ (Overview)
  ├── Active sessions summary
  ├── Context utilization gauge (contextTokens / modelWindow)
  ├── Today's cost vs weekly average
  ├── Recent compact events (last 3)
  └── Active suggestions (critical first)

/cost
  ├── Daily cost bar chart (last 30 days)
  ├── Cost by category pie chart
  ├── Model cost breakdown table
  └── Monthly projection

/compacts
  ├── Timeline of all compact events
  ├── Per-event: compacted message list + summary diff
  ├── Importance scores for lost content
  └── Quick action: [Save to memory]

/context
  ├── Workspace file size table (raw vs injected, truncation badge)
  ├── Token distribution estimate
  └── Suggestions for file optimization

/memory
  ├── MEMORY.md viewer + inline editor
  ├── Daily notes browser (calendar view)
  ├── Semantic search across all memory
  └── Add / edit / delete entries

/sessions
  ├── All sessions table (key, model, tokens, last active)
  ├── Token trend per session
  └── Compact history per session
```

---

## 9. OpenClaw Skill (IM Integration)

**File structure**:

```
skills/clawprobe/
├── SKILL.md        Teaches the agent how to use clawprobe tools
├── tools.json      Tool definitions
└── probe-tool.sh   Shell script calling clawprobe CLI
```

**SKILL.md** (excerpt):

```markdown
## clawprobe

clawprobe is an observability tool installed on this machine.
Use these tools to answer questions about token costs, memory, and context.

Available commands (run via exec tool):
- `clawprobe status --json`       Current session status
- `clawprobe cost --week --json`  This week's API cost
- `clawprobe compacts --json`     Recent compaction events
- `clawprobe suggest --json`      Optimization suggestions
- `clawprobe memory search <q>`   Search agent memory
- `clawprobe memory add <text>`   Add to long-term memory
```

**Supported IM commands** (user sends to OpenClaw, which calls clawprobe):

```
probe status          → current token usage and session info
probe cost            → this week's API cost summary
probe cost today      → today only
probe compacts        → last 3 compaction events
probe suggest         → top optimization suggestions
probe memory <query>  → search memory
probe save <text>     → add text to MEMORY.md
```

---

## 10. Project Structure

```
clawprobe/
├── package.json
├── tsconfig.json
├── README.md
├── USER_MANUAL.md
├── src/
│   ├── index.ts              Entry point (CLI)
│   ├── daemon.ts             Background daemon process
│   ├── core/
│   │   ├── config.ts         OpenClaw config detection
│   │   ├── watcher.ts        File system watcher (chokidar)
│   │   ├── jsonl-parser.ts   .jsonl transcript parser
│   │   ├── session-store.ts  sessions.json reader
│   │   ├── db.ts             clawprobe SQLite (probe.db)
│   │   └── memory-editor.ts  MEMORY.md read/write
│   ├── engines/
│   │   ├── cost.ts           Token-to-USD cost calculation
│   │   ├── compact-diff.ts   Compaction analysis
│   │   ├── file-analyzer.ts  Workspace file size/truncation
│   │   └── rule-engine.ts    Optimization suggestions
│   ├── cli/
│   │   ├── commands/
│   │   │   ├── status.ts
│   │   │   ├── cost.ts
│   │   │   ├── compacts.ts
│   │   │   ├── memory.ts
│   │   │   ├── context.ts
│   │   │   └── suggest.ts
│   │   └── format.ts         Terminal output formatting
│   ├── server/
│   │   ├── app.ts            Express HTTP server
│   │   ├── routes/           API route handlers
│   │   └── ws.ts             WebSocket event emitter
│   └── dashboard/            React frontend (bundled)
│       ├── pages/
│       ├── components/
│       └── hooks/
├── skills/
│   └── clawprobe/
│       ├── SKILL.md
│       ├── tools.json
│       └── probe-tool.sh
└── docs/
    └── screenshots/
```

---

## 11. Technology Stack

| Layer | Technology | Reason |
|-------|-----------|--------|
| Runtime | Node.js ≥ 22 | Matches OpenClaw's requirement |
| Language | TypeScript | Matches OpenClaw's ecosystem |
| File watching | chokidar | Battle-tested, cross-platform |
| SQLite | better-sqlite3 | Synchronous API, fast local queries |
| CLI framework | commander.js | Standard, well-documented |
| Terminal UI | chalk + cli-table3 | Clean output without heavy deps |
| HTTP server | express | Minimal, familiar |
| WebSocket | ws | Lightweight |
| Frontend | React + Vite + Tailwind | Fast development |
| Charts | recharts | React-native charting |
| Frontend bundling | Vite (embedded in dist/) | Single binary deployment |

**Total production dependencies**: < 15 packages  
**No cloud services. No telemetry. No API keys required.**

---

## 12. Installation & Distribution

### npm global install (primary)

```bash
npm install -g clawprobe
```

### One-liner (curl)

```bash
curl -fsSL https://clawprobe.dev/install.sh | bash
```

### ClawHub Skill install

```bash
openclaw plugins install @clawprobe/skill
```

### First run

```bash
clawprobe start
# Auto-detects ~/.openclaw and starts daemon + web dashboard
# Dashboard available at http://localhost:4747
```

---

## 13. MVP Milestone Plan

### Week 1–2: Core Engine

- [ ] `config.ts`: Detect OpenClaw installation and read `openclaw.json`
- [ ] `session-store.ts`: Parse `sessions.json`, extract token counts
- [ ] `jsonl-parser.ts`: Parse `.jsonl` transcripts, detect compaction entries
- [ ] `db.ts`: Initialize `probe.db` schema, write session snapshots
- [ ] `cost.ts`: Token-to-USD calculation with model price table
- [ ] `watcher.ts`: File system monitoring with chokidar

### Week 3–4: CLI

- [ ] `clawprobe status` — session status with token bar
- [ ] `clawprobe cost --week` — weekly cost breakdown
- [ ] `clawprobe compacts --last 5` — compact event list
- [ ] `clawprobe context` — workspace file size analysis
- [ ] `clawprobe memory list/search/add/edit/delete`
- [ ] `clawprobe suggest` — basic rule engine

### Week 5–6: Web Dashboard

- [ ] HTTP server + WebSocket setup
- [ ] Overview page
- [ ] Cost trend charts
- [ ] Compact event timeline with diff view
- [ ] Memory browser

### Week 7–8: OpenClaw Skill + Polish + Launch

- [ ] Skill packaging (`SKILL.md`, `tools.json`, `probe-tool.sh`)
- [ ] ClawHub listing
- [ ] npm publish
- [ ] README and documentation
- [ ] GitHub Actions CI (lint + test)

---

## 14. Known Limitations (MVP)

| Limitation | Impact | Future fix |
|-----------|--------|-----------|
| Context breakdown is estimated (not exact) | 70-80% accuracy for system prompt breakdown | V2: ContextEngine Wrapper |
| Retrieval process internals not visible | Cannot show what the memory engine searched | V2: Engine adapters |
| Real-time `assemble()` snapshot unavailable | Context breakdown is file-based estimate | V2: ContextEngine Wrapper |
| Output token count accuracy depends on sessions.json | Provider-dependent (some providers omit output count) | Monitor per-provider gaps |
| lossless-claw lcm.db integration | Not integrated in MVP | Post-MVP adapter |
