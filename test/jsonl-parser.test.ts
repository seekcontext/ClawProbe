import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAll, parseIncremental, resetCursor, getCompactedMessages } from '../src/core/jsonl-parser.js';
import { analyzeCompaction } from '../src/engines/compact-diff.js';
import { createFixture, cleanupFixture, writeTranscript } from './helpers.js';

test('parseAll finds compact events and compacted messages', () => {
  const fixture = createFixture();
  try {
    const transcript = writeTranscript(fixture, 'sess_1', [
      { type: 'session', id: 's1', cwd: '/tmp', timestamp: 1 },
      { type: 'message', id: 'm1', parentId: 's1', role: 'user', content: 'Prefer PostgreSQL over MySQL' },
      { type: 'message', id: 'm2', parentId: 'm1', role: 'assistant', content: 'Will do.' },
      { type: 'message', id: 'm3', parentId: 'm2', role: 'user', content: 'Use snake_case for API responses' },
      { type: 'compaction', id: 'c1', parentId: 'm3', firstKeptEntryId: 'm3', tokensBefore: 12345, content: 'User is building an API', timestamp: 10 },
    ]);

    const parsed = parseAll(transcript);
    assert.equal(parsed.compactEvents.length, 1);
    const compacted = getCompactedMessages(parsed.entries, parsed.compactEvents[0]!);
    assert.equal(compacted.length, 2);
    assert.match(compacted[0]!.content, /PostgreSQL/);

    const analysis = analyzeCompaction(parsed.compactEvents[0]!, parsed.entries);
    assert.ok(analysis.importantLosses.length >= 1);
    assert.ok(['good', 'partial'].includes(analysis.summaryQuality));
  } finally {
    cleanupFixture(fixture);
  }
});

test('parseIncremental only returns appended entries', async () => {
  const fixture = createFixture();
  try {
    const transcript = writeTranscript(fixture, 'sess_2', [
      { type: 'session', id: 's1', cwd: '/tmp', timestamp: 1 },
      { type: 'message', id: 'm1', parentId: 's1', role: 'user', content: 'hello' },
    ]);

    const first = parseIncremental(transcript);
    assert.equal(first.entries.length, 2);

    const fs = await import('node:fs');
    fs.appendFileSync(transcript, JSON.stringify({ type: 'message', id: 'm2', parentId: 'm1', role: 'assistant', content: 'world' }) + '\n');
    const second = parseIncremental(transcript);
    assert.equal(second.entries.length, 1);
    assert.equal((second.entries[0] as { id: string }).id, 'm2');

    resetCursor(transcript);
    const reset = parseIncremental(transcript);
    assert.equal(reset.entries.length, 3);
  } finally {
    cleanupFixture(fixture);
  }
});
