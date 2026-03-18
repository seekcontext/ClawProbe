# clawprobe

**实时掌握你的 OpenClaw Agent 状态。**

Token 用量、API 成本、上下文健康度、智能告警 —— 一站式呈现，无需改动 OpenClaw 任何代码。

[![npm](https://img.shields.io/npm/v/clawprobe)](https://www.npmjs.com/package/clawprobe)
[![npm downloads](https://img.shields.io/npm/dm/clawprobe)](https://www.npmjs.com/package/clawprobe)
[![GitHub Stars](https://img.shields.io/github/stars/seekcontext/ClawProbe)](https://github.com/seekcontext/ClawProbe)
[![License](https://img.shields.io/github/license/seekcontext/ClawProbe)](./LICENSE)

[English](./README.md) · [简体中文](./README.zh-CN.md) · [日本語](./README.ja.md)

[为什么选择 clawprobe](#为什么选择-clawprobe) •
[快速开始](#快速开始) •
[命令说明](#命令说明) •
[Agent 集成](#agent-集成) •
[配置](#配置) •
[工作原理](#工作原理)

---

## 为什么选择 clawprobe

你的 OpenClaw Agent 在上下文窗口里悄悄运行 —— 消耗 Token、静默压缩对话、花掉 API 预算。但这一切发生时，你什么都看不见。

clawprobe 解决这个问题。它在后台监听 OpenClaw 的文件，让你实时了解 Agent 正在做什么：

| 你的疑问 | clawprobe 的答案 |
|---------|----------------|
| "Agent 现在状态正常吗？" | `clawprobe status` — 即时快照 |
| "我想持续盯着它看" | `clawprobe top` — 实时仪表盘，自动刷新 |
| "为什么上下文老是被压缩？" | `clawprobe context` + `clawprobe suggest` |
| "压缩后 Agent 忘了什么？" | `clawprobe compacts` |
| "这花了我多少钱？" | `clawprobe cost --week`，内置主流模型价格 |
| "TOOLS.md 有没有完整传给模型？" | 内置截断检测，自动告警 |

**零配置。零副作用。100% 本地运行。**

---

## 快速开始

```bash
npm install -g clawprobe

clawprobe start    # 启动后台守护进程（自动识别 OpenClaw 安装路径）
clawprobe status   # 查看即时快照
```

clawprobe 自动识别你的 OpenClaw 安装。无需 API Key、无需注册账号、无遥测数据上报。

---

## 命令说明

### `clawprobe status` — 即时快照

一眼看清当前会话、模型、上下文用量、今日花费和活跃告警。

```
$ clawprobe status

📊  Agent Status  (active session)
──────────────────────────────────────────────────
  Agent:     main
  Session:   agent:main:workspace:direct:xxx ●
  Model:     moonshot/kimi-k2.5
  Active:    Today 16:41   Compacts: 2

  Context:   87.3K / 200.0K tokens  ███████░░░  44%
  Tokens:    72.4K in / 5.2K out

  Today:     $0.12  → clawprobe cost 查看详情

  🟡  上下文窗口已用 44%
       → 建议开启新会话或手动触发压缩
```

---

### `clawprobe top` — 实时仪表盘

在侧边终端打开，Agent 跑长任务时持续盯着它。每 2 秒自动刷新 —— 上下文进度条、成本计数器、逐轮 Token 消耗一览无余。

```
clawprobe top  refreshing every 2s  (q / Ctrl+C to quit)     03/18/2026 17:42:35
────────────────────────────────────────────────────────────────────────────────
  Agent: main   ● daemon running
  Session: agent:main:workspace:direct:xxx  ● active
  Model:   moonshot/kimi-k2.5
  Active:  Today 17:42   Compacts: 2
────────────────────────────────────────────────────────────────────────────────
  Context   ████████░░░░░░░░░░░░░░░░  44%   87.3K / 200.0K tokens
  Headroom  112.7K tokens remaining (56%)
────────────────────────────────────────────────────────────────────────────────
  Session cost  $0.52        Input   859.2K tok      Output   29.8K tok
  Today total   $0.67        Cache read   712.0K tok
────────────────────────────────────────────────────────────────────────────────
  Recent turns
  Turn  Time      ΔInput   ΔOutput  Cost          Note
  27    17:42     22.0K    908      $0.0094        ← latest
  26    17:19     990      630      $0.0026
  25    17:19     20.4K    661      $0.0094
  24    15:57     564      39       $0.0014
  23    15:56     18.8K    231      $0.0076        ◆ compact
────────────────────────────────────────────────────────────────────────────────
  🟡  Context window at 44% capacity
  Costs are estimates based on public pricing.
```

按 `q` 或 `Ctrl+C` 退出，不会破坏终端原有内容。

```bash
clawprobe top                  # 默认 2 秒刷新
clawprobe top --interval 5     # 5 秒刷新
clawprobe top --agent coder    # 指定 Agent
```

---

### `clawprobe cost` — API 成本统计

内置 30+ 模型价格，分别统计输入、输出、缓存 Token 的费用。支持按天、周、月、全部查看。

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

  价格为估算值，请以模型厂商账单为准。
```

已内置价格：OpenAI（GPT-4o、o1、o3、o4-mini）、Anthropic（Claude 3/3.5/3.7 Sonnet/Opus/Haiku）、Google（Gemini 2.0/2.5 Flash/Pro）、Moonshot（kimi-k2.5）、DeepSeek（v3、r1）等。未收录的模型可通过 `~/.clawprobe/config.json` 自定义添加。

---

### `clawprobe session` — 会话详情

查看任意会话的总成本、Token 时间线，以及每一轮的具体消耗。

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

### `clawprobe context` — 上下文窗口分析

看清是什么在占用上下文，在截断问题造成麻烦之前提前发现。

```
$ clawprobe context

🔍  Context Window  agent: main
──────────────────────────────────────────────────
  Used:    87.3K / 200.0K tokens  ███████░░░  44%

  Workspace overhead:  ~4.2K tokens  (7 injected files)
  Conversation est:    ~83.1K tokens  (messages + system prompt + tools)

  ⚠ TOOLS.md: 31% truncated — 模型看不到这部分内容
    请在 openclaw.json 中提高 bootstrapMaxChars

  Remaining:  112.7K tokens (56%)
```

---

### `clawprobe compacts` — 压缩事件记录

每次上下文压缩都被完整记录。看清被丢弃了什么，并在彻底消失前将关键内容归档。

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

### `clawprobe suggest` — 优化建议

自动检测常见问题，只在真正需要关注时才触发提醒。

| 规则 | 检测内容 |
|------|---------|
| `tools-truncation` | TOOLS.md 被截断，模型看不到部分工具描述 |
| `high-compact-freq` | 上下文填充过快，每 < 30 分钟就触发一次压缩 |
| `context-headroom` | 上下文窗口已用超过 90%，压缩即将发生 |
| `cost-spike` | 今日花费超过周均 2 倍 |
| `memory-bloat` | MEMORY.md 过大，每轮都在浪费 Token |

屏蔽不需要的规则：`clawprobe suggest --dismiss <rule-id>`

---

## Agent 集成

clawprobe 专为**被 Agent 调用**而设计，而不只是给人用。所有命令都支持 `--json` 输出结构化数据，错误也始终以 JSON 格式返回，不会有破坏解析的彩色文本。

### 单次健康检查

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

### 查询输出结构

```bash
clawprobe schema           # 列出所有命令
clawprobe schema status    # status --json 的完整字段说明
clawprobe schema cost      # cost --json 的完整字段说明
```

### 程序化屏蔽建议

```bash
clawprobe suggest --dismiss context-headroom --json
# → { "ok": true, "dismissed": "context-headroom" }
```

### 错误响应始终可解析

```bash
clawprobe session --json   # 无活跃会话时
# → { "ok": false, "error": "no_active_session", "message": "..." }
# exit code 1
```

---

## 配置

可选配置文件 `~/.clawprobe/config.json`，首次运行 `clawprobe start` 时自动创建：

```json
{
  "timezone": "Asia/Shanghai",
  "openclaw": {
    "dir": "~/.openclaw",
    "agent": "main"
  },
  "cost": {
    "customPrices": {
      "my-provider/my-model": { "input": 1.00, "output": 3.00 }
    }
  },
  "alerts": {
    "dailyBudgetUsd": 5.00
  },
  "rules": {
    "disabled": ["memory-bloat"]
  }
}
```

大多数用户无需任何配置，clawprobe 会自动从现有的 OpenClaw 配置中读取所有信息。

---

## 工作原理

clawprobe 在后台读取 OpenClaw 的现有文件 —— 无需修改代码、无需插件、无需 Hook。

- **零配置** — 自动识别 `~/.openclaw` 下的 OpenClaw 安装
- **零副作用** — 从不修改 OpenClaw 的文件，只写入 `~/.clawprobe/` 目录
- **后台守护** — `clawprobe start` 启动文件监听，保持本地数据库实时更新
- **极简依赖** — 仅 4 个生产依赖，无云服务，无遥测

---

## 隐私

- **100% 本地运行** — 数据不会离开你的机器
- **无遥测** — clawprobe 不收集任何数据
- **无账号，无 API Key** — 安装即用

---

## 兼容性

支持所有版本的 OpenClaw。需要 Node.js ≥ 22 · macOS 或 Linux（Windows 通过 WSL2）。

---

## 参与贡献

MIT 开源协议，欢迎贡献。

```bash
git clone https://github.com/seekcontext/ClawProbe
cd ClawProbe && npm install && npm run dev
```

---

[MIT License](./LICENSE)
