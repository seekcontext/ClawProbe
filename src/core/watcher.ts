import chokidar, { FSWatcher } from "chokidar";
import path from "path";

export type ChangeEvent = "add" | "change" | "unlink";

export interface FileChange {
  event: ChangeEvent;
  filePath: string;
  category: "sessions_json" | "jsonl" | "workspace_md" | "openclaw_config" | "other";
}

export type ChangeHandler = (change: FileChange) => void;

function categorize(filePath: string): FileChange["category"] {
  const base = path.basename(filePath);
  const ext = path.extname(filePath);

  if (base === "sessions.json") return "sessions_json";
  if (ext === ".jsonl") return "jsonl";
  if (base === "openclaw.json") return "openclaw_config";
  if (ext === ".md") return "workspace_md";
  return "other";
}

export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private handlers: ChangeHandler[] = [];
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly debounceMs: number;

  constructor(debounceMs = 500) {
    this.debounceMs = debounceMs;
  }

  watch(globs: string[]): this {
    this.watcher = chokidar.watch(globs, {
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 100,
      },
      ignored: [
        "**/node_modules/**",
        "**/.git/**",
        "**/probe.db*",
      ],
    });

    const emit = (event: ChangeEvent, filePath: string) => {
      const key = `${event}:${filePath}`;
      const existing = this.debounceTimers.get(key);
      if (existing) clearTimeout(existing);

      this.debounceTimers.set(
        key,
        setTimeout(() => {
          this.debounceTimers.delete(key);
          const change: FileChange = {
            event,
            filePath,
            category: categorize(filePath),
          };
          for (const h of this.handlers) h(change);
        }, this.debounceMs)
      );
    };

    this.watcher
      .on("add", (p) => emit("add", p))
      .on("change", (p) => emit("change", p))
      .on("unlink", (p) => emit("unlink", p));

    return this;
  }

  on(handler: ChangeHandler): this {
    this.handlers.push(handler);
    return this;
  }

  async close(): Promise<void> {
    for (const t of this.debounceTimers.values()) clearTimeout(t);
    this.debounceTimers.clear();
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }
}

export function buildWatchGlobs(
  openclawDir: string,
  workspaceDir: string,
  sessionsDir: string
): string[] {
  return [
    path.join(sessionsDir, "sessions.json"),
    path.join(sessionsDir, "*.jsonl"),
    path.join(workspaceDir, "*.md"),
    path.join(workspaceDir, "memory", "*.md"),
    path.join(openclawDir, "openclaw.json"),
  ];
}
