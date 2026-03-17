import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openDb, upsertCompactEvent } from '../src/core/db.js';
import { analyzeWorkspaceFiles, snapshotWorkspaceFiles, getLatestWorkspaceAnalysis } from '../src/engines/file-analyzer.js';
import { runRules } from '../src/engines/rule-engine.js';
import { createFixture, cleanupFixture, seedSessionSnapshots } from './helpers.js';

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
