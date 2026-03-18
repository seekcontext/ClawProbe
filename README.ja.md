# clawprobe

**OpenClaw エージェントの状態をリアルタイムで把握する。**

トークン使用量・API コスト・コンテキスト健全性・スマートアラート —— すべてを一箇所で、OpenClaw のコードを一切変更せずに。

[![npm](https://img.shields.io/npm/v/clawprobe)](https://www.npmjs.com/package/clawprobe)
[![npm downloads](https://img.shields.io/npm/dm/clawprobe)](https://www.npmjs.com/package/clawprobe)
[![GitHub Stars](https://img.shields.io/github/stars/seekcontext/ClawProbe)](https://github.com/seekcontext/ClawProbe)
[![License](https://img.shields.io/github/license/seekcontext/ClawProbe)](./LICENSE)

[なぜ clawprobe か](#なぜ-clawprobe-か) •
[クイックスタート](#クイックスタート) •
[コマンド一覧](#コマンド一覧) •
[エージェント連携](#エージェント連携) •
[設定](#設定) •
[仕組み](#仕組み)

---

## なぜ clawprobe か

OpenClaw エージェントはコンテキストウィンドウの中で静かに動いています —— トークンを消費し、会話をサイレント圧縮し、API 予算を使い続けています。しかしその様子は、実行中はまったく見えません。

clawprobe はこの問題を解決します。バックグラウンドで OpenClaw のファイルを監視し、エージェントが今何をしているかをリアルタイムで可視化します。

| あなたの疑問 | clawprobe の答え |
|------------|----------------|
| 「エージェントは今、正常に動いている？」 | `clawprobe status` — 即時スナップショット |
| 「ずっと見ていたい」 | `clawprobe top` — 自動更新のライブダッシュボード |
| 「なぜコンテキストがすぐ圧縮されるの？」 | `clawprobe context` + `clawprobe suggest` |
| 「圧縮後にエージェントが忘れたことは？」 | `clawprobe compacts` |
| 「これ、いくらかかってるの？」 | `clawprobe cost --week`（主要モデルの価格内蔵） |
| 「TOOLS.md はちゃんとモデルに届いている？」 | トランケーション検出を内蔵 |

**設定不要。副作用ゼロ。100% ローカル動作。**

---

## クイックスタート

```bash
npm install -g clawprobe

clawprobe start    # バックグラウンドデーモンを起動（OpenClaw を自動検出）
clawprobe status   # 即時スナップショットを確認
```

clawprobe は OpenClaw のインストール先を自動検出します。API キー不要、アカウント登録不要、テレメトリなし。

---

## コマンド一覧

### `clawprobe status` — 即時スナップショット

セッション・モデル・コンテキスト使用率・本日のコスト・アクティブなアラートを一目で確認。

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

  Today:     $0.12  → clawprobe cost で詳細を確認

  🟡  コンテキストウィンドウが 44% に達しています
       → 新しいセッションを開始するか、手動で圧縮することを推奨
```

---

### `clawprobe top` — ライブダッシュボード

エージェントが長いタスクを実行している間、サイドターミナルで開いておきましょう。2 秒ごとに自動更新 —— コンテキスト進捗バー、コストカウンター、ターンごとのトークン消費をリアルタイムで表示します。

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

`q` または `Ctrl+C` で終了。ターミナルの表示を壊さずクリーンに終了します。

```bash
clawprobe top                  # デフォルト 2 秒更新
clawprobe top --interval 5     # 5 秒更新
clawprobe top --agent coder    # 特定のエージェントを指定
```

---

### `clawprobe cost` — API コスト追跡

30 以上のモデルの価格を内蔵。入力・出力・キャッシュトークンを個別に集計。日・週・月・全期間で表示できます。

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

  コストは推定値です。正確な金額はプロバイダーの請求画面でご確認ください。
```

内蔵済み価格：OpenAI（GPT-4o、o1、o3、o4-mini）、Anthropic（Claude 3/3.5/3.7 Sonnet/Opus/Haiku）、Google（Gemini 2.0/2.5 Flash/Pro）、Moonshot（kimi-k2.5）、DeepSeek（v3、r1）など。未収録モデルは `~/.clawprobe/config.json` でカスタム追加できます。

---

### `clawprobe session` — セッション詳細

任意のセッションを掘り下げる：合計コスト・トークン推移・各ターンの消費量を確認。

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

### `clawprobe context` — コンテキストウィンドウ分析

何がコンテキストを圧迫しているかを把握し、問題が起きる前にサイレントなトランケーションを検出します。

```
$ clawprobe context

🔍  Context Window  agent: main
──────────────────────────────────────────────────
  Used:    87.3K / 200.0K tokens  ███████░░░  44%

  Workspace overhead:  ~4.2K tokens  (7 injected files)
  Conversation est:    ~83.1K tokens  (messages + system prompt + tools)

  ⚠ TOOLS.md: 31% truncated — この部分はモデルに届いていません
    openclaw.json の bootstrapMaxChars を増やしてください

  Remaining:  112.7K tokens (56%)
```

---

### `clawprobe compacts` — 圧縮イベント記録

すべての圧縮イベントを記録。何が失われたかを確認し、完全に消える前に重要なコンテキストをアーカイブできます。

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

### `clawprobe suggest` — 最適化アドバイス

よくある問題を自動検出。本当に注意が必要なときだけ通知します。

| ルール | 検出内容 |
|--------|---------|
| `tools-truncation` | TOOLS.md が切り捨てられ、モデルがツール定義を参照できない |
| `high-compact-freq` | コンテキストの充填が速すぎ、30 分未満ごとに圧縮が発生 |
| `context-headroom` | コンテキストウィンドウの使用率が 90% 超 — 圧縮が間近 |
| `cost-spike` | 本日の支出が週平均の 2 倍超 |
| `memory-bloat` | MEMORY.md が大きすぎ、毎ターンでトークンを無駄に消費 |

不要なルールを無効化：`clawprobe suggest --dismiss <rule-id>`

---

## エージェント連携

clawprobe は**エージェントから呼び出されること**を想定して設計されています。すべてのコマンドが `--json` 出力をサポートし、エラーも常に構造化 JSON で返ります。パースを壊すカラーテキストは出力しません。

### ワンコールでヘルスチェック

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

### 出力スキーマを確認する

```bash
clawprobe schema           # 全コマンドを一覧表示
clawprobe schema status    # status --json のフィールド仕様
clawprobe schema cost      # cost --json のフィールド仕様
```

### プログラムからアドバイスを無効化

```bash
clawprobe suggest --dismiss context-headroom --json
# → { "ok": true, "dismissed": "context-headroom" }
```

### エラーレスポンスは常にパース可能

```bash
clawprobe session --json   # アクティブなセッションがない場合
# → { "ok": false, "error": "no_active_session", "message": "..." }
# exit code 1
```

---

## 設定

オプション設定ファイル `~/.clawprobe/config.json` —— 初回の `clawprobe start` 実行時に自動生成されます：

```json
{
  "timezone": "Asia/Tokyo",
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

ほとんどのユーザーに設定は不要です。clawprobe は既存の OpenClaw 設定からすべてを自動検出します。

---

## 仕組み

clawprobe はバックグラウンドで OpenClaw の既存ファイルを読み取ります —— コード変更・プラグイン・フック一切不要。

- **設定不要** — `~/.openclaw` の OpenClaw を自動検出
- **副作用ゼロ** — OpenClaw のファイルには一切触れず、`~/.clawprobe/` のみに書き込む
- **バックグラウンドデーモン** — `clawprobe start` がファイル変更を監視し、ローカル DB を随時更新
- **最小フットプリント** — 本番依存パッケージは 4 つのみ、クラウドサービスなし、テレメトリなし

---

## プライバシー

- **100% ローカル動作** — データが外部に送信されることはありません
- **テレメトリなし** — clawprobe は何も収集しません
- **アカウント不要・API キー不要** — インストールしてすぐ使えます

---

## 動作環境

すべてのバージョンの OpenClaw に対応。Node.js ≥ 22 · macOS または Linux（Windows は WSL2 経由）が必要です。

---

## コントリビューション

MIT ライセンス。コントリビューション歓迎です。

```bash
git clone https://github.com/seekcontext/ClawProbe
cd ClawProbe && npm install && npm run dev
```

---

[MIT License](./LICENSE)
