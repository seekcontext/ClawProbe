import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, resetDb, insertSessionSnapshot } from '../src/core/db.js';
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

test('recordDailyCost and getPeriodCost aggregate daily usage', () => {
  const fixture = createFixture();
  try {
    const db = openDb(fixture.probeDir);
    const today = todayString();
    recordDailyCost(db, 'main', 'sess_1', today, 1_000_000, 0, 'anthropic/claude-sonnet-4.5');
    recordDailyCost(db, 'main', 'sess_1', today, 0, 1_000_000, 'anthropic/claude-sonnet-4.5');

    const summary = getPeriodCost(db, 'main', 'day');
    assert.equal(summary.daily.length, 1);
    assert.equal(summary.totalUsd, 18);
    assert.equal(summary.inputTokens, 1_000_000);
    assert.equal(summary.outputTokens, 1_000_000);
  } finally {
    cleanupFixture(fixture);
  }
});
