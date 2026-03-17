import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { addEntry, listEntries, updateEntry, deleteEntry, saveCompactedMessages, searchAllMemoryFiles } from '../src/core/memory-editor.js';
import { createFixture, cleanupFixture } from './helpers.js';

test('memory editor can add update delete and search entries', () => {
  const fixture = createFixture();
  try {
    const memoryFile = path.join(fixture.workspaceDir, 'MEMORY.md');
    addEntry(memoryFile, 'Prefer PostgreSQL');
    addEntry(memoryFile, 'Use snake_case');

    let entries = listEntries(memoryFile);
    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.content, 'Prefer PostgreSQL');

    updateEntry(memoryFile, 2, 'Use camelCase only in frontend');
    entries = listEntries(memoryFile);
    assert.equal(entries[1]?.content, 'Use camelCase only in frontend');

    deleteEntry(memoryFile, 1);
    entries = listEntries(memoryFile);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.content, 'Use camelCase only in frontend');

    fs.writeFileSync(path.join(fixture.workspaceDir, 'memory', '2026-03-17.md'), '- PostgreSQL migration notes\n', 'utf-8');
    const results = searchAllMemoryFiles(fixture.workspaceDir, 'postgres');
    assert.equal(results.length, 1);
  } finally {
    cleanupFixture(fixture);
  }
});

test('saveCompactedMessages appends compact rescue entries', () => {
  const fixture = createFixture();
  try {
    const memoryFile = path.join(fixture.workspaceDir, 'MEMORY.md');
    saveCompactedMessages(memoryFile, [
      { type: 'message', id: 'm1', parentId: 'x', role: 'user', content: 'Prefer PostgreSQL' },
      { type: 'message', id: 'm2', parentId: 'm1', role: 'assistant', content: 'Acknowledged' },
      { type: 'message', id: 'm3', parentId: 'm2', role: 'tool', content: 'irrelevant' },
    ], 'Today 14:22');

    const raw = fs.readFileSync(memoryFile, 'utf-8');
    assert.match(raw, /Saved from compact: Today 14:22/);
    assert.match(raw, /\[User\] Prefer PostgreSQL/);
    assert.match(raw, /\[Agent\] Acknowledged/);
    assert.doesNotMatch(raw, /irrelevant/);
  } finally {
    cleanupFixture(fixture);
  }
});
