import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, resetDb, insertSessionSnapshot, insertFileSnapshot, getLatestFileSnapshots } from '../src/core/db.js';
import { estimateCost, getSessionCost, recordDailyCost, getPeriodCost, todayString } from '../src/engines/cost.js';
import { createFixture, cleanupFixture } from './helpers.js';

test('estimateCost supports exact and fuzzy model matches', () => {
  assert.equal(estimateCost({ input: 1_000_000, output: 0 }, 'anthropic/claude-sonnet-4.5'), 3);
  assert.equal(estimateCost({ input: 1_000_000, output: 0 }, 'claude-sonnet-4.5'), 3);
  assert.equal(estimateCost({ input: 1_000_000, output: 500_000 }, null), 0);
});

test('getSessionCost computes deltas and turn-level compaction spikes', () => {
  const fixture = createFixture();
  try {
    const db = openDb(fixture.probeDir);
    insertSessionSnapshot(db, {
      agent: 'main', session_key: 'sess_1', session_id: 'sess_1', model: 'anthropic/claude-sonnet-4.5', provider: 'anthropic',
      input_tokens: 0, output_tokens: 0, total_tokens: 0, context_tokens: 1000, compaction_count: 0, sampled_at: 100,
    });
    insertSessionSnapshot(db, {
      agent: 'main', session_key: 'sess_1', session_id: 'sess_1', model: 'anthropic/claude-sonnet-4.5', provider: 'anthropic',
      input_tokens: 500, output_tokens: 100, total_tokens: 600, context_tokens: 2000, compaction_count: 0, sampled_at: 160,
    });
    insertSessionSnapshot(db, {
      agent: 'main', session_key: 'sess_1', session_id: 'sess_1', model: 'anthropic/claude-sonnet-4.5', provider: 'anthropic',
      input_tokens: 2500, output_tokens: 300, total_tokens: 2800, context_tokens: 3000, compaction_count: 1, sampled_at: 220,
    });

    const session = getSessionCost(db, 'main', 'sess_1');
    assert.ok(session);
    assert.equal(session?.inputTokens, 2500);
    assert.equal(session?.outputTokens, 300);
    assert.equal(session?.turns.length, 2);
    assert.equal(session?.turns[1]?.compactOccurred, true);
    assert.equal(session?.durationMin, 2);
  } finally {
    cleanupFixture(fixture);
  }
});

// --- Duplicate-snapshot regression tests ---

test('duplicate session snapshot same second: token deltas not double-counted in getSessionCost', () => {
  // Regression: daemon triggers processSessionsJson twice in the same second.
  // The second insertSessionSnapshot call must overwrite (upsert) rather than
  // insert a new row, so getAllSnapshots returns exactly 2 rows and the delta
  // between them is counted once, not twice.
  const fixture = createFixture();
  try {
    const db = openDb(fixture.probeDir);
    const base = { agent: 'main', session_key: 's1', session_id: 's1', model: 'anthropic/claude-sonnet-4.5', provider: 'anthropic' };

    // t=100: baseline
    insertSessionSnapshot(db, { ...base, input_tokens: 0, output_tokens: 0, total_tokens: 0, context_tokens: 0, compaction_count: 0, sampled_at: 100 });
    // t=200: first trigger
    insertSessionSnapshot(db, { ...base, input_tokens: 1000, output_tokens: 200, total_tokens: 1200, context_tokens: 5000, compaction_count: 0, sampled_at: 200 });
    // t=200 again (same second, daemon fires twice): must upsert, not insert
    insertSessionSnapshot(db, { ...base, input_tokens: 1000, output_tokens: 200, total_tokens: 1200, context_tokens: 5000, compaction_count: 0, sampled_at: 200 });

    const session = getSessionCost(db, 'main', 's1');
    assert.ok(session, 'session should exist');
    // Exactly 2 snapshots → 1 turn, delta = 1000 input / 200 output (counted once)
    assert.equal(session!.turns.length, 1, 'should have exactly 1 turn, not 2');
    assert.equal(session!.inputTokens, 1000);
    assert.equal(session!.outputTokens, 200);
  } finally {
    cleanupFixture(fixture);
  }
});

test('duplicate session snapshot same second: recordDailyCost called with correct single delta', async () => {
  // Regression: if two identical snapshots at the same sampled_at were stored,
  // the daemon would call recordDailyCost twice with the same delta.
  // With upsert, the second insert is a no-op → cost is recorded only once.
  const fixture = createFixture();
  try {
    const db = openDb(fixture.probeDir);
    const base = { agent: 'main', session_key: 's1', session_id: 's1', model: 'anthropic/claude-sonnet-4.5', provider: 'anthropic' };
    const today = todayString();

    insertSessionSnapshot(db, { ...base, input_tokens: 0, output_tokens: 0, total_tokens: 0, context_tokens: 0, compaction_count: 0, sampled_at: 100 });
    insertSessionSnapshot(db, { ...base, input_tokens: 1_000_000, output_tokens: 0, total_tokens: 1_000_000, context_tokens: 5000, compaction_count: 0, sampled_at: 200 });
    // Duplicate at same second:
    insertSessionSnapshot(db, { ...base, input_tokens: 1_000_000, output_tokens: 0, total_tokens: 1_000_000, context_tokens: 5000, compaction_count: 0, sampled_at: 200 });

    // Simulate what daemon does: record cost based on last two snapshots
    const { getAllSnapshots } = await import('../src/core/db.js');
    const snaps = getAllSnapshots(db, 'main', 's1');
    assert.equal(snaps.length, 2, 'upsert must keep only 2 rows');

    const prev = snaps[snaps.length - 2]!;
    const curr = snaps[snaps.length - 1]!;
    const inDelta = Math.max(0, curr.input_tokens - prev.input_tokens);
    const outDelta = Math.max(0, curr.output_tokens - prev.output_tokens);
    recordDailyCost(db, 'main', 's1', today, inDelta, outDelta, curr.model);

    const summary = getPeriodCost(db, 'main', 'day');
    // 1M input tokens at claude-sonnet-4.5 = $3.00 (recorded once)
    assert.equal(summary.totalUsd, 3, 'cost must be recorded exactly once');
  } finally {
    cleanupFixture(fixture);
  }
});

test('duplicate file snapshot same second: getLatestFileSnapshots returns each file once', () => {
  // Regression: snapshotWorkspaceFiles called twice in same second should not
  // produce duplicate rows visible in context output.
  const fixture = createFixture();
  try {
    const db = openDb(fixture.probeDir);
    const t = Math.floor(Date.now() / 1000);

    const snap = (rawChars: number) => ({ agent: 'main', file_path: '/ws/AGENTS.md', raw_chars: rawChars, injected_chars: rawChars, was_truncated: 0, sampled_at: t });

    insertFileSnapshot(db, snap(1000));
    insertFileSnapshot(db, snap(1000)); // exact duplicate → upsert
    insertFileSnapshot(db, snap(1000)); // third call same second → still upsert

    const rows = getLatestFileSnapshots(db, 'main');
    assert.equal(rows.length, 1, 'must return exactly 1 row per file, not 3');
    assert.equal(rows[0]!.raw_chars, 1000);
  } finally {
    cleanupFixture(fixture);
  }
});

test('duplicate file snapshot same second: token total not inflated in context analysis', () => {
  // If the same file is snapshotted 3× in one second, the context token estimate
  // must equal chars/4 (for one copy), not chars/4 * 3.
  const fixture = createFixture();
  try {
    const db = openDb(fixture.probeDir);
    const t = Math.floor(Date.now() / 1000);
    const rawChars = 4000;

    for (let i = 0; i < 3; i++) {
      insertFileSnapshot(db, { agent: 'main', file_path: '/ws/SOUL.md', raw_chars: rawChars, injected_chars: rawChars, was_truncated: 0, sampled_at: t });
    }

    const rows = getLatestFileSnapshots(db, 'main');
    assert.equal(rows.length, 1);
    const estTokens = Math.ceil(rows[0]!.injected_chars / 4);
    assert.equal(estTokens, 1000, 'token estimate must be for a single copy of the file');
  } finally {
    cleanupFixture(fixture);
  }
});

test('recordDailyCost and getPeriodCost aggregate daily usage', () => {
  const fixture = createFixture();
  try {
    const db = openDb(fixture.probeDir);
    const today = todayString();
    recordDailyCost(db, 'main', 'sess_1', today, 1_000_000, 0, 'anthropic/claude-sonnet-4.5');
    recordDailyCost(db, 'main', 'sess_2', today, 0, 1_000_000, 'anthropic/claude-sonnet-4.5');

    const summary = getPeriodCost(db, 'main', 'day');
    assert.equal(summary.daily.length, 1);
    assert.equal(summary.totalUsd, 18);
    assert.equal(summary.inputTokens, 1_000_000);
    assert.equal(summary.outputTokens, 1_000_000);
  } finally {
    cleanupFixture(fixture);
  }
});
