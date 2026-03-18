import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openDb, insertSessionSnapshot, upsertCompactEvent } from '../src/core/db.js';
import { getWindowSize } from '../src/core/model-windows.js';
import { analyzeWorkspaceFiles, snapshotWorkspaceFiles, getLatestWorkspaceAnalysis } from '../src/engines/file-analyzer.js';
import { runRules } from '../src/engines/rule-engine.js';
import { createFixture, cleanupFixture, seedSessionSnapshots, writeSessionsJson, writeTranscript } from './helpers.js';

test('file analyzer detects truncation and persists snapshots', () => {
  const fixture = createFixture();
  try {
    fs.writeFileSync(path.join(fixture.workspaceDir, 'TOOLS.md'), 'x'.repeat(40), 'utf-8');
    fs.writeFileSync(path.join(fixture.workspaceDir, 'SOUL.md'), 'abc', 'utf-8');

    const analysis = analyzeWorkspaceFiles(fixture.workspaceDir, 20);
    assert.equal(analysis.truncatedFiles.length, 1);
    assert.equal(analysis.truncatedFiles[0]?.name, 'TOOLS.md');
    assert.equal(analysis.truncatedFiles[0]?.injectedChars, 20);

    const db = openDb(fixture.probeDir);
    snapshotWorkspaceFiles(db, 'main', fixture.workspaceDir, 20);
    const latest = getLatestWorkspaceAnalysis(db, 'main', fixture.workspaceDir, 20);
    assert.equal(latest.files.length, 2);
  } finally {
    cleanupFixture(fixture);
  }
});

test('rule engine emits truncation, compaction, context leak and cost suggestions', () => {
  const fixture = createFixture();
  try {
    fs.writeFileSync(path.join(fixture.workspaceDir, 'TOOLS.md'), 'x'.repeat(40), 'utf-8');
    fs.writeFileSync(path.join(fixture.workspaceDir, 'MEMORY.md'), 'm'.repeat(60_000), 'utf-8');
    fs.writeFileSync(path.join(fixture.workspaceDir, 'IDENTITY.md'), 'old', 'utf-8');
    fs.writeFileSync(path.join(fixture.workspaceDir, 'HEARTBEAT.md'), 'old', 'utf-8');

    const oldMs = Date.now() - 40 * 86400_000;
    fs.utimesSync(path.join(fixture.workspaceDir, 'IDENTITY.md'), oldMs / 1000, oldMs / 1000);
    fs.utimesSync(path.join(fixture.workspaceDir, 'HEARTBEAT.md'), oldMs / 1000, oldMs / 1000);

    const db = openDb(fixture.probeDir);
    seedSessionSnapshots(fixture);
    writeSessionsJson(fixture, {
      sessions: {
        sess_1: {
          sessionId: 'sess_1',
          updatedAt: 220,
          inputTokens: 6000,
          outputTokens: 800,
          totalTokens: 6800,
          sessionTokens: 190000,
          contextTokens: 200000,
          ctxSize: 200000,
          compactionCount: 1,
          modelOverride: 'anthropic/claude-sonnet-4.5',
          providerOverride: 'anthropic',
        },
      },
    });
    upsertCompactEvent(db, {
      agent: 'main', session_key: 'sess_1', compaction_entry_id: 'c1', first_kept_entry_id: 'm3', tokens_before: 1, summary_text: 's', compacted_at: 1000, compacted_message_count: 1, compacted_messages: '[]',
    });
    upsertCompactEvent(db, {
      agent: 'main', session_key: 'sess_1', compaction_entry_id: 'c2', first_kept_entry_id: 'm4', tokens_before: 1, summary_text: 's', compacted_at: 1200, compacted_message_count: 1, compacted_messages: '[]',
    });
    upsertCompactEvent(db, {
      agent: 'main', session_key: 'sess_1', compaction_entry_id: 'c3', first_kept_entry_id: 'm5', tokens_before: 1, summary_text: 's', compacted_at: 1500, compacted_message_count: 1, compacted_messages: '[]',
    });

    db.prepare('INSERT INTO cost_records (agent, session_key, date, input_tokens, output_tokens, model, estimated_usd, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('main', 'sess_old', '2026-03-15', 100, 20, 'anthropic/claude-sonnet-4.5', 1, 1);
    db.prepare('INSERT INTO cost_records (agent, session_key, date, input_tokens, output_tokens, model, estimated_usd, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('main', 'sess_old2', '2026-03-16', 100, 20, 'anthropic/claude-sonnet-4.5', 1, 1);
    const today = new Date().toISOString().slice(0, 10);
    db.prepare('INSERT INTO cost_records (agent, session_key, date, input_tokens, output_tokens, model, estimated_usd, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('main', 'sess_1', today, 100, 20, 'anthropic/claude-sonnet-4.5', 3, 1);

    const suggestions = runRules({
      db,
      agent: 'main',
      workspaceDir: fixture.workspaceDir,
      sessionsDir: fixture.sessionsDir,
      bootstrapMaxChars: 20,
      config: {
        openclaw: { dir: fixture.openclawDir, agent: 'main' },
        server: { port: 4747, host: '127.0.0.1' },
        cost: { customPrices: {} },
        alerts: {},
        memory: { defaultFile: 'MEMORY.md' },
        rules: { disabled: [], compactionFreqThresholdMin: 30, memoryBloatThresholdChars: 50000 },
      },
    });

    const ids = suggestions.map((s) => s.ruleId);
    assert.ok(ids.includes('tools-truncation'));
    assert.ok(ids.includes('high-compact-freq'));
    assert.ok(ids.includes('context-headroom'));
    assert.ok(ids.includes('cost-spike'));
    assert.ok(ids.includes('memory-bloat'));
    assert.ok(ids.includes('stale-workspace-files'));
  } finally {
    cleanupFixture(fixture);
  }
});

test('getWindowSize matches known and unknown models', () => {
  assert.equal(getWindowSize('kimi-k2.5', 12_700), 256_000);
  assert.equal(getWindowSize('gpt-5.4', 1_000), 128_000);
  assert.equal(getWindowSize('unknown-model', 256_000), 256_000);
});

test('rule engine context-headroom uses actual session tokens instead of sessions window size', () => {
  const fixture = createFixture();
  try {
    writeSessionsJson(fixture, {
      sessions: {
        'agent:main:kimi': {
          sessionId: 'sess_kimi',
          updatedAt: 220,
          inputTokens: 6000,
          outputTokens: 800,
          totalTokens: 6800,
          sessionTokens: 12_700,
          contextTokens: 256_000,
          ctxSize: 256_000,
          compactionCount: 0,
          modelOverride: 'kimi-k2.5',
        },
      },
    });

    const db = openDb(fixture.probeDir);
    insertSessionSnapshot(db, {
      agent: 'main',
      session_key: 'agent:main:kimi',
      session_id: 'sess_kimi',
      model: 'kimi-k2.5',
      provider: 'moonshot',
      input_tokens: 6000,
      output_tokens: 800,
      total_tokens: 6800,
      context_tokens: 256_000,
      compaction_count: 0,
      sampled_at: 220,
    });

    const suggestions = runRules({
      db,
      agent: 'main',
      workspaceDir: fixture.workspaceDir,
      sessionsDir: fixture.sessionsDir,
      bootstrapMaxChars: 20,
      config: {
        openclaw: { dir: fixture.openclawDir, agent: 'main' },
        server: { port: 4747, host: '127.0.0.1' },
        cost: { customPrices: {} },
        alerts: {},
        memory: { defaultFile: 'MEMORY.md' },
        rules: { disabled: [], compactionFreqThresholdMin: 30, memoryBloatThresholdChars: 50000 },
      },
    });

    assert.equal(suggestions.some((s) => s.ruleId === 'context-headroom'), false);
  } finally {
    cleanupFixture(fixture);
  }
});

test('rule engine context-headroom prefers transcript total tokens when available', () => {
  const fixture = createFixture();
  try {
    writeSessionsJson(fixture, {
      sessions: {
        'agent:main:kimi': {
          sessionId: 'sess_kimi',
          sessionFile: 'sess_kimi.jsonl',
          updatedAt: 220,
          inputTokens: 6000,
          outputTokens: 800,
          totalTokens: 6800,
          sessionTokens: 12_700,
          contextTokens: 256_000,
          ctxSize: 256_000,
          compactionCount: 0,
        },
      },
    });

    writeTranscript(fixture, 'sess_kimi', [
      { type: 'session', id: 'sess_kimi', cwd: '/tmp', timestamp: 1 },
      {
        type: 'message',
        timestamp: 1_000,
        message: { id: 'u1', parentId: 'sess_kimi', role: 'user', content: 'hello' },
      },
      {
        type: 'message',
        timestamp: 2_000,
        message: {
          id: 'a1',
          parentId: 'u1',
          role: 'assistant',
          content: [],
          model: 'kimi-k2.5',
          provider: 'moonshot',
          usage: { input: 12_000, output: 500, cacheRead: 0, cacheWrite: 0, totalTokens: 240_000 },
          timestamp: 2_000,
        },
      },
    ]);

    const db = openDb(fixture.probeDir);
    insertSessionSnapshot(db, {
      agent: 'main',
      session_key: 'agent:main:kimi',
      session_id: 'sess_kimi',
      model: 'kimi-k2.5',
      provider: 'moonshot',
      input_tokens: 6000,
      output_tokens: 800,
      total_tokens: 6800,
      context_tokens: 256_000,
      compaction_count: 0,
      sampled_at: 220,
    });

    const suggestions = runRules({
      db,
      agent: 'main',
      workspaceDir: fixture.workspaceDir,
      sessionsDir: fixture.sessionsDir,
      bootstrapMaxChars: 20,
      config: {
        openclaw: { dir: fixture.openclawDir, agent: 'main' },
        server: { port: 4747, host: '127.0.0.1' },
        cost: { customPrices: {} },
        alerts: {},
        memory: { defaultFile: 'MEMORY.md' },
        rules: { disabled: [], compactionFreqThresholdMin: 30, memoryBloatThresholdChars: 50000 },
      },
    });

    const headroom = suggestions.find((s) => s.ruleId === 'context-headroom');
    assert.ok(headroom);
    assert.match(headroom.title, /94% capacity/);
    assert.match(headroom.detail, /240,000 tokens/);
    assert.match(headroom.detail, /256,000/);
  } finally {
    cleanupFixture(fixture);
  }
});
