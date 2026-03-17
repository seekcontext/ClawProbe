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
