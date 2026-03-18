import fs from "fs";
import path from "path";
import os from "os";

export interface OpenClawCompactionConfig {
  reserveTokens?: number;
  keepRecentTokens?: number;
}

export interface OpenClawConfig {
  agents?: {
    defaults?: {
      workspace?: string;
      bootstrapMaxChars?: number;
      compaction?: OpenClawCompactionConfig;
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

export interface ProbeConfig {
  openclaw: {
    dir: string;
    agent: string;
  };
  server: {
    port: number;
    host: string;
  };
  cost: {
    customPrices: Record<string, { input: number; output: number }>;
  };
  alerts: {
    dailyBudgetUsd?: number;
    weeklyBudgetUsd?: number;
  };
  memory: {
    defaultFile: string;
  };
  rules: {
    disabled: string[];
    compactionFreqThresholdMin: number;
    memoryBloatThresholdChars: number;
  };
}

export interface ResolvedConfig {
  probe: ProbeConfig;
  openclaw: OpenClawConfig;
  openclawDir: string;
  workspaceDir: string;
  sessionsDir: string;
  bootstrapMaxChars: number;
  probeDir: string;
}

const DEFAULT_PROBE_CONFIG: ProbeConfig = {
  openclaw: {
    dir: path.join(os.homedir(), ".openclaw"),
    agent: "main",
  },
  server: {
    port: 4747,
    host: "127.0.0.1",
  },
  cost: {
    customPrices: {},
  },
  alerts: {},
  memory: {
    defaultFile: "MEMORY.md",
  },
  rules: {
    disabled: [],
    compactionFreqThresholdMin: 30,
    memoryBloatThresholdChars: 50000,
  },
};

export function resolveConfig(overrides: Partial<ProbeConfig> = {}): ResolvedConfig {
  const probeDir = path.join(os.homedir(), ".clawprobe");
  const probeConfigPath = path.join(probeDir, "config.json");

  let fileConfig: Partial<ProbeConfig> = {};
  if (fs.existsSync(probeConfigPath)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(probeConfigPath, "utf-8"));
    } catch {
      // ignore malformed config
    }
  }

  const probe: ProbeConfig = deepMerge(
    DEFAULT_PROBE_CONFIG,
    fileConfig,
    overrides
  ) as ProbeConfig;

  // OPENCLAW_DIR env var takes priority
  const openclawDir = process.env["OPENCLAW_DIR"] ?? probe.openclaw.dir;

  const openclawConfigPath = path.join(openclawDir, "openclaw.json");
  let openclawConfig: OpenClawConfig = {};
  if (fs.existsSync(openclawConfigPath)) {
    try {
      openclawConfig = JSON.parse(fs.readFileSync(openclawConfigPath, "utf-8"));
    } catch {
      // ignore malformed config
    }
  }

  const workspaceDir =
    openclawConfig.agents?.defaults?.workspace ??
    path.join(openclawDir, "workspace");

  const sessionsDir = path.join(
    openclawDir,
    "agents",
    probe.openclaw.agent,
    "sessions"
  );

  const bootstrapMaxChars =
    openclawConfig.agents?.defaults?.bootstrapMaxChars ?? 20000;

  return {
    probe,
    openclaw: openclawConfig,
    openclawDir,
    workspaceDir,
    sessionsDir,
    bootstrapMaxChars,
    probeDir,
  };
}

/**
 * Write a commented config template to ~/.clawprobe/config.json if it does not already exist.
 * Returns true when the file was newly created, false when it already existed.
 */
export function initConfigTemplate(probeDir: string): boolean {
  const configPath = path.join(probeDir, "config.json");
  if (fs.existsSync(configPath)) return false;

  fs.mkdirSync(probeDir, { recursive: true });

  // Prices are USD / 1 M tokens as of March 2026.
  // Add or override entries under cost.customPrices for models not listed here.
  const template = {
    _comment: "clawprobe config — https://github.com/openclaw/clawprobe",
    openclaw: {
      dir: path.join(os.homedir(), ".openclaw"),
      agent: "main",
    },
    server: {
      port: 4747,
      host: "127.0.0.1",
    },
    alerts: {
      dailyBudgetUsd: 5.0,
      weeklyBudgetUsd: 20.0,
    },
    memory: {
      defaultFile: "MEMORY.md",
    },
    rules: {
      disabled: [],
      compactionFreqThresholdMin: 30,
      memoryBloatThresholdChars: 50000,
    },
    cost: {
      _pricingNote: "USD per 1M tokens — built-in prices auto-apply; add entries here only to override or add unlisted models",
      _pricingUpdated: "2026-03",
      _builtInPrices: {
        "anthropic/claude-opus-4":      { input: 15.00, output: 75.00 },
        "anthropic/claude-opus-4.6":    { input: 5.00,  output: 25.00 },
        "anthropic/claude-sonnet-4.5":  { input: 3.00,  output: 15.00 },
        "anthropic/claude-sonnet-4.6":  { input: 3.00,  output: 15.00 },
        "anthropic/claude-haiku-3.5":   { input: 0.80,  output: 4.00  },
        "anthropic/claude-haiku-4.5":   { input: 1.00,  output: 5.00  },
        "openai/gpt-4o":                { input: 2.50,  output: 10.00 },
        "openai/gpt-4o-mini":           { input: 0.15,  output: 0.60  },
        "openai/o3":                    { input: 2.00,  output: 8.00  },
        "openai/gpt-5.4":               { input: 5.00,  output: 20.00 },
        "openai/gpt-5.4-mini":          { input: 0.30,  output: 1.20  },
        "openai/o4-mini":               { input: 1.10,  output: 4.40  },
        "google/gemini-2.5-flash":      { input: 0.30,  output: 2.50  },
        "google/gemini-2.5-pro":        { input: 1.25,  output: 10.00 },
        "google/gemini-3.1-flash":      { input: 0.075, output: 0.30  },
        "google/gemini-3.1-pro":        { input: 1.25,  output: 5.00  },
        "deepseek/deepseek-v3":         { input: 0.27,  output: 1.10  },
        "deepseek/deepseek-v3.2":       { input: 0.28,  output: 0.42  },
        "deepseek/deepseek-r1":         { input: 0.55,  output: 2.19  },
        "mistral/mistral-large":        { input: 0.50,  output: 1.50  },
        "mistral/mistral-small":        { input: 0.10,  output: 0.30  },
        "moonshot/kimi-k2":             { input: 0.40,  output: 2.00  },
        "moonshot/kimi-k2.5":           { input: 0.45,  output: 2.20  },
        "qwen/qwen3-max":               { input: 0.34,  output: 1.38  },
        "qwen/qwen3.5-plus":            { input: 0.11,  output: 0.66  },
        "qwen/qwen3.5-flash":           { input: 0.065, output: 0.26  },
        "zhipu/glm-4-32b":              { input: 0.10,  output: 0.10  },
        "bytedance/doubao-1.5-pro-32k": { input: 0.069, output: 0.069 },
      },
      customPricesNote: "Add entries here to override built-in prices or add unlisted models, e.g.: \"my-provider/my-model\": { \"input\": 1.0, \"output\": 3.0 }",
      customPrices: {},
    },
  };

  fs.writeFileSync(configPath, JSON.stringify(template, null, 2) + "\n", "utf-8");
  return true;
}

export function assertOpenClawExists(cfg: ResolvedConfig): void {
  if (!fs.existsSync(cfg.openclawDir)) {
    console.error(
      `Error: OpenClaw directory not found at ${cfg.openclawDir}\n` +
        `Set OPENCLAW_DIR environment variable or add "openclaw.dir" to ~/.clawprobe/config.json`
    );
    process.exit(1);
  }
}

function deepMerge(...objects: object[]): object {
  const result: Record<string, unknown> = {};
  for (const obj of objects) {
    for (const [key, value] of Object.entries(obj)) {
      if (
        value !== undefined &&
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        typeof result[key] === "object" &&
        result[key] !== null &&
        !Array.isArray(result[key])
      ) {
        result[key] = deepMerge(
          result[key] as object,
          value as object
        );
      } else if (value !== undefined) {
        result[key] = value;
      }
    }
  }
  return result;
}
