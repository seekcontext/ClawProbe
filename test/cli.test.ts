import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openDb, insertSessionSnapshot, resetDb } from '../src/core/db.js';
import { createFixture, cleanupFixture, runCli, writeOpenClawConfig, writeSessionsJson, writeTranscript } from './helpers.js';

test('CLI config --json resolves OpenClaw paths', () => {
  const fixture = createFixture();
  try {
    writeOpenClawConfig(fixture, { models: { default: 'anthropic/claude-sonnet-4.5' } });

    const result = runCli(fixture, ['config', '--json']);
    assert.equal(result.status, 0, result.stderr);

    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.openclawDir, fixture.openclawDir);
    assert.equal(parsed.workspaceDir, fixture.workspaceDir);
    assert.equal(parsed.bootstrapMaxChars, 20);
  } finally {
    cleanupFixture(fixture);
  }
});

test('CLI session --json returns per-session cost breakdown', () => {
  const fixture = createFixture();
  try {
    writeOpenClawConfig(fixture);
    writeSessionsJson(fixture, {
      sessions: {
        sess_1: {
          sessionId: 'sess_1',
          sessionFile: 'sess_1.jsonl',
          updatedAt: 220,
          inputTokens: 6000,
          outputTokens: 800,
          totalTokens: 6800,
          contextTokens: 190000,
          compactionCount: 1,
          modelOverride: 'anthropic/claude-sonnet-4.5',
          providerOverride: 'anthropic',
        },
      },
    });
    writeTranscript(fixture, 'sess_1', [
      { type: 'session', id: 'sess_1', cwd: fixture.workspaceDir, timestamp: 1000 },
      {
        type: 'message',
        timestamp: 1000,
        message: {
          id: 'u1',
          parentId: 'sess_1',
          role: 'user',
          content: [{ type: 'text', text: 'hello' }],
        },
      },
      {
        type: 'message',
        timestamp: 160000,
        message: {
          id: 'a1',
          parentId: 'u1',
          role: 'assistant',
          content: [{ type: 'text', text: 'world' }],
          model: 'anthropic/claude-sonnet-4.5',
          provider: 'anthropic',
          usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, totalTokens: 1500 },
          timestamp: 160000,
        },
      },
      {
        type: 'compaction',
        id: 'c1',
        parentId: 'a1',
        firstKeptEntryId: 'a1',
        tokensBefore: 5000,
        content: 'summary',
        timestamp: 200000,
      },
      {
        type: 'message',
        timestamp: 220000,
        message: {
          id: 'a2',
          parentId: 'a1',
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
          model: 'anthropic/claude-sonnet-4.5',
          provider: 'anthropic',
          usage: { input: 6000, output: 600, cacheRead: 0, cacheWrite: 0, totalTokens: 190000 },
          timestamp: 220000,
        },
      },
    ]);

    const db = openDb(fixture.probeDir);
    insertSessionSnapshot(db, {
      agent: 'main', session_key: 'sess_1', session_id: 'sess_1', model: 'anthropic/claude-sonnet-4.5', provider: 'anthropic',
      input_tokens: 0, output_tokens: 0, total_tokens: 0, context_tokens: 1000, compaction_count: 0, sampled_at: 100,
    });
    insertSessionSnapshot(db, {
      agent: 'main', session_key: 'sess_1', session_id: 'sess_1', model: 'anthropic/claude-sonnet-4.5', provider: 'anthropic',
      input_tokens: 1000, output_tokens: 200, total_tokens: 1200, context_tokens: 1500, compaction_count: 0, sampled_at: 160,
    });
    insertSessionSnapshot(db, {
      agent: 'main', session_key: 'sess_1', session_id: 'sess_1', model: 'anthropic/claude-sonnet-4.5', provider: 'anthropic',
      input_tokens: 6000, output_tokens: 800, total_tokens: 6800, context_tokens: 190000, compaction_count: 1, sampled_at: 220,
    });
    resetDb();

    const result = runCli(fixture, ['session', 'sess_1', '--json']);
    assert.equal(result.status, 0, result.stderr);

    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.sessionKey, 'sess_1');
    assert.equal(parsed.inputTokens, 6000);
    assert.equal(parsed.outputTokens, 800);
    assert.equal(parsed.compactionCount, 1);
    assert.equal(parsed.turns.length, 2);
    assert.equal(parsed.turns[1].compactOccurred, false);
  } finally {
    cleanupFixture(fixture);
  }
});

test('CLI memory list --json returns memory entries', () => {
  const fixture = createFixture();
  try {
    writeOpenClawConfig(fixture);
    fs.writeFileSync(path.join(fixture.workspaceDir, 'MEMORY.md'), '- Prefer PostgreSQL\n- Use snake_case\n', 'utf-8');

    const result = runCli(fixture, ['memory', 'list', '--json']);
    assert.equal(result.status, 0, result.stderr);

    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.file, 'MEMORY.md');
    assert.equal(parsed.entries.length, 2);
    assert.equal(parsed.entries[0].content, 'Prefer PostgreSQL');
  } finally {
    cleanupFixture(fixture);
  }
});
