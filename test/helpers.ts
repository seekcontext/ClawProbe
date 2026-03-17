import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { resetDb, openDb, insertSessionSnapshot, upsertCompactEvent } from '../src/core/db.js';

export interface TestFixture {
  rootDir: string;
  homeDir: string;
  openclawDir: string;
  workspaceDir: string;
  sessionsDir: string;
  probeDir: string;
}

export function createFixture(): TestFixture {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawprobe-test-'));
  const homeDir = path.join(rootDir, 'home');
  const openclawDir = path.join(homeDir, '.openclaw');
  const workspaceDir = path.join(openclawDir, 'workspace');
  const sessionsDir = path.join(openclawDir, 'agents', 'main', 'sessions');
  const probeDir = path.join(homeDir, '.clawprobe');

  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(path.join(workspaceDir, 'memory'), { recursive: true });
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(probeDir, { recursive: true });

  return { rootDir, homeDir, openclawDir, workspaceDir, sessionsDir, probeDir };
}

export function cleanupFixture(fixture: TestFixture): void {
  resetDb();
  fs.rmSync(fixture.rootDir, { recursive: true, force: true });
}

export function writeOpenClawConfig(fixture: TestFixture, extra: object = {}): void {
  fs.writeFileSync(
    path.join(fixture.openclawDir, 'openclaw.json'),
    JSON.stringify({
      agents: {
        defaults: {
          workspace: fixture.workspaceDir,
          bootstrapMaxChars: 20,
        },
      },
      ...extra,
    }),
    'utf-8'
  );
}

export function writeSessionsJson(fixture: TestFixture, data: object): void {
  fs.writeFileSync(path.join(fixture.sessionsDir, 'sessions.json'), JSON.stringify(data), 'utf-8');
}

export function writeTranscript(fixture: TestFixture, sessionKey: string, lines: unknown[]): string {
  const filePath = path.join(fixture.sessionsDir, `${sessionKey}.jsonl`);
  fs.writeFileSync(filePath, lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf-8');
  return filePath;
}

export function seedSessionSnapshots(fixture: TestFixture, sessionKey = 'sess_1'): void {
  const db = openDb(fixture.probeDir);
  insertSessionSnapshot(db, {
    agent: 'main',
    session_key: sessionKey,
    session_id: sessionKey,
    model: 'anthropic/claude-sonnet-4.5',
    provider: 'anthropic',
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    context_tokens: 1000,
    compaction_count: 0,
    sampled_at: 100,
  });
  insertSessionSnapshot(db, {
    agent: 'main',
    session_key: sessionKey,
    session_id: sessionKey,
    model: 'anthropic/claude-sonnet-4.5',
    provider: 'anthropic',
    input_tokens: 1000,
    output_tokens: 200,
    total_tokens: 1200,
    context_tokens: 180000,
    compaction_count: 0,
    sampled_at: 160,
  });
  insertSessionSnapshot(db, {
    agent: 'main',
    session_key: sessionKey,
    session_id: sessionKey,
    model: 'anthropic/claude-sonnet-4.5',
    provider: 'anthropic',
    input_tokens: 6000,
    output_tokens: 800,
    total_tokens: 6800,
    context_tokens: 190000,
    compaction_count: 1,
    sampled_at: 220,
  });
}

export function seedCompactEvents(fixture: TestFixture): void {
  const db = openDb(fixture.probeDir);
  upsertCompactEvent(db, {
    agent: 'main',
    session_key: 'sess_1',
    compaction_entry_id: 'cmp_1',
    first_kept_entry_id: 'm3',
    tokens_before: 30000,
    summary_text: 'summary',
    compacted_at: 1000,
    compacted_message_count: 2,
    compacted_messages: JSON.stringify([{ id: 'm1', role: 'user', content: 'Prefer PostgreSQL' }]),
  });
  upsertCompactEvent(db, {
    agent: 'main',
    session_key: 'sess_1',
    compaction_entry_id: 'cmp_2',
    first_kept_entry_id: 'm4',
    tokens_before: 32000,
    summary_text: 'summary',
    compacted_at: 2000,
    compacted_message_count: 2,
    compacted_messages: JSON.stringify([{ id: 'm2', role: 'user', content: 'Use snake_case' }]),
  });
  upsertCompactEvent(db, {
    agent: 'main',
    session_key: 'sess_1',
    compaction_entry_id: 'cmp_3',
    first_kept_entry_id: 'm5',
    tokens_before: 34000,
    summary_text: 'summary',
    compacted_at: 3000,
    compacted_message_count: 2,
    compacted_messages: JSON.stringify([{ id: 'm3', role: 'user', content: 'Avoid try/catch in loops' }]),
  });
}

export function runCli(fixture: TestFixture, args: string[]): { status: number; stdout: string; stderr: string } {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const result = spawnSync(
    process.execPath,
    ['./node_modules/tsx/dist/cli.mjs', 'src/index.ts', ...args],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        HOME: fixture.homeDir,
        OPENCLAW_DIR: fixture.openclawDir,
        FORCE_COLOR: '0',
      },
      encoding: 'utf-8',
    }
  );

  return {
    status: result.status ?? 0,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
