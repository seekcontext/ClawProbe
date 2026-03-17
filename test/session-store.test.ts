import test from 'node:test';
import assert from 'node:assert/strict';
import { readSessionsStore, getActiveSession, sessionKeyFromPath } from '../src/core/session-store.js';
import { createFixture, cleanupFixture, writeSessionsJson } from './helpers.js';

test('readSessionsStore supports nested sessions shape and sorts by updatedAt', () => {
  const fixture = createFixture();
  try {
    writeSessionsJson(fixture, {
      sessions: {
        sess_old: { updatedAt: 10, inputTokens: 5, outputTokens: 1 },
        sess_new: { updatedAt: 20, inputTokens: 8, outputTokens: 2, modelOverride: 'gpt-5.4-mini' },
      },
    });

    const sessions = readSessionsStore(fixture.sessionsDir);
    assert.equal(sessions.length, 2);
    assert.equal(sessions[0]?.sessionKey, 'sess_new');
    assert.equal(sessions[0]?.totalTokens, 10);
    assert.equal(getActiveSession(fixture.sessionsDir)?.sessionKey, 'sess_new');
  } finally {
    cleanupFixture(fixture);
  }
});

test('readSessionsStore supports flat sessions shape', () => {
  const fixture = createFixture();
  try {
    writeSessionsJson(fixture, {
      sess_a: { sessionId: 'a', updatedAt: 1, inputTokens: 3, outputTokens: 4, totalTokens: 7 },
    });

    const sessions = readSessionsStore(fixture.sessionsDir);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.sessionId, 'a');
    assert.equal(sessions[0]?.totalTokens, 7);
  } finally {
    cleanupFixture(fixture);
  }
});

test('sessionKeyFromPath strips .jsonl suffix', () => {
  assert.equal(sessionKeyFromPath('/tmp/foo/sess_123.jsonl'), 'sess_123');
});
