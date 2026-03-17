import fs from "fs";
import path from "path";
import { DatabaseSync } from "node:sqlite";
import { insertFileSnapshot, getLatestFileSnapshots, FileSnapshotRow } from "../core/db.js";

export interface WorkspaceFile {
  name: string;
  filePath: string;
  rawChars: number;
  injectedChars: number;
  wasTruncated: boolean;
  lostChars: number;
  lostPercent: number;
  estTokens: number;          // rough estimate: chars / 4
  injectedEstTokens: number;
  exists: boolean;
}

export interface WorkspaceAnalysis {
  files: WorkspaceFile[];
  totalRawChars: number;
  totalInjectedChars: number;
  truncatedFiles: WorkspaceFile[];
  bootstrapMaxChars: number;
}

const WORKSPACE_FILES = [
  "SOUL.md",
  "AGENTS.md",
  "TOOLS.md",
  "USER.md",
  "IDENTITY.md",
  "MEMORY.md",
  "HEARTBEAT.md",
  "GLOBAL_AGENTS.md",
];

export function analyzeWorkspaceFiles(
  workspaceDir: string,
  bootstrapMaxChars: number
): WorkspaceAnalysis {
  const files: WorkspaceFile[] = [];

  for (const name of WORKSPACE_FILES) {
    const filePath = path.join(workspaceDir, name);
    const wf = analyzeFile(name, filePath, bootstrapMaxChars);
    files.push(wf);
  }

  // Also scan any extra .md files in the workspace root
  if (fs.existsSync(workspaceDir)) {
    const extra = fs
      .readdirSync(workspaceDir)
      .filter(
        (f) =>
          f.endsWith(".md") &&
          !WORKSPACE_FILES.includes(f) &&
          !f.startsWith(".")
      );
    for (const name of extra) {
      const filePath = path.join(workspaceDir, name);
      if (fs.statSync(filePath).isFile()) {
        files.push(analyzeFile(name, filePath, bootstrapMaxChars));
      }
    }
  }

  const existing = files.filter((f) => f.exists);
  const totalRawChars = existing.reduce((s, f) => s + f.rawChars, 0);
  const totalInjectedChars = existing.reduce((s, f) => s + f.injectedChars, 0);
  const truncatedFiles = existing.filter((f) => f.wasTruncated);

  return {
    files: existing.sort((a, b) => b.rawChars - a.rawChars),
    totalRawChars,
    totalInjectedChars,
    truncatedFiles,
    bootstrapMaxChars,
  };
}

function analyzeFile(
  name: string,
  filePath: string,
  bootstrapMaxChars: number
): WorkspaceFile {
  if (!fs.existsSync(filePath)) {
    return {
      name,
      filePath,
      rawChars: 0,
      injectedChars: 0,
      wasTruncated: false,
      lostChars: 0,
      lostPercent: 0,
      estTokens: 0,
      injectedEstTokens: 0,
      exists: false,
    };
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const rawChars = content.length;
  const injectedChars = Math.min(rawChars, bootstrapMaxChars);
  const wasTruncated = rawChars > bootstrapMaxChars;
  const lostChars = rawChars - injectedChars;
  const lostPercent = rawChars > 0 ? (lostChars / rawChars) * 100 : 0;

  return {
    name,
    filePath,
    rawChars,
    injectedChars,
    wasTruncated,
    lostChars,
    lostPercent,
    estTokens: Math.ceil(rawChars / 4),
    injectedEstTokens: Math.ceil(injectedChars / 4),
    exists: true,
  };
}

export function snapshotWorkspaceFiles(
  db: DatabaseSync,
  agent: string,
  workspaceDir: string,
  bootstrapMaxChars: number
): void {
  const analysis = analyzeWorkspaceFiles(workspaceDir, bootstrapMaxChars);
  const now = Math.floor(Date.now() / 1000);

  for (const f of analysis.files) {
    insertFileSnapshot(db, {
      agent,
      file_path: f.filePath,
      raw_chars: f.rawChars,
      injected_chars: f.injectedChars,
      was_truncated: f.wasTruncated ? 1 : 0,
      sampled_at: now,
    });
  }
}

export function getLatestWorkspaceAnalysis(
  db: DatabaseSync,
  agent: string,
  workspaceDir: string,
  bootstrapMaxChars: number
): WorkspaceAnalysis {
  const rows: FileSnapshotRow[] = getLatestFileSnapshots(db, agent);

  if (rows.length === 0) {
    // Fallback: read directly from disk
    return analyzeWorkspaceFiles(workspaceDir, bootstrapMaxChars);
  }

  const files: WorkspaceFile[] = rows.map((r) => {
    const name = path.basename(r.file_path);
    const lostChars = r.raw_chars - r.injected_chars;
    const lostPercent = r.raw_chars > 0 ? (lostChars / r.raw_chars) * 100 : 0;
    return {
      name,
      filePath: r.file_path,
      rawChars: r.raw_chars,
      injectedChars: r.injected_chars,
      wasTruncated: r.was_truncated === 1,
      lostChars,
      lostPercent,
      estTokens: Math.ceil(r.raw_chars / 4),
      injectedEstTokens: Math.ceil(r.injected_chars / 4),
      exists: true,
    };
  });

  return {
    files,
    totalRawChars: files.reduce((s, f) => s + f.rawChars, 0),
    totalInjectedChars: files.reduce((s, f) => s + f.injectedChars, 0),
    truncatedFiles: files.filter((f) => f.wasTruncated),
    bootstrapMaxChars,
  };
}

export function getFileStaleness(workspaceDir: string): { name: string; daysSinceModified: number }[] {
  const now = Date.now();
  const results: { name: string; daysSinceModified: number }[] = [];

  for (const name of WORKSPACE_FILES) {
    const filePath = path.join(workspaceDir, name);
    if (!fs.existsSync(filePath)) continue;
    const stat = fs.statSync(filePath);
    const daysSince = (now - stat.mtimeMs) / 86400_000;
    results.push({ name, daysSinceModified: Math.floor(daysSince) });
  }

  return results.sort((a, b) => b.daysSinceModified - a.daysSinceModified);
}
