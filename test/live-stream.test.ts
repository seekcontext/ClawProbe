import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { entryToLiveEvents, summarizeToolInput, findMostRecentJsonl, startLiveStream } from '../src/core/live-stream.js';
import { createFixture, cleanupFixture, writeTranscript } from './helpers.js';
import type { JournalEntry } from '../src/core/jsonl-parser.js';

// ── summarizeToolInput ────────────────────────────────────────────────────────

test('summarizeToolInput: Read returns basename', () => {
  assert.equal(summarizeToolInput('Read', { path: '/home/user/project/src/auth.ts' }), 'auth.ts');
});

test('summarizeToolInput: Edit returns basename', () => {
  assert.equal(summarizeToolInput('Edit', { path: '/deep/nested/path/file.md' }), 'file.md');
});

test('summarizeToolInput: Bash truncates long commands', () => {
  const cmd = 'a'.repeat(60);
  const result = summarizeToolInput('Bash', { command: cmd });
  assert.ok(result.endsWith('…'));
  assert.ok(result.length <= 56); // 55 + '…'
});

test('summarizeToolInput: Bash returns short command as-is', () => {
  assert.equal(summarizeToolInput('Bash', { command: 'npm test' }), 'npm test');
});

test('summarizeToolInput: WebSearch truncates long query', () => {
  const query = 'q'.repeat(60);
  const result = summarizeToolInput('WebSearch', { query });
  assert.ok(result.endsWith('…'));
});

test('summarizeToolInput: TodoWrite shows item count', () => {
  assert.equal(
    summarizeToolInput('TodoWrite', { todos: [{}, {}, {}] }),
    '3 items'
  );
  assert.equal(
    summarizeToolInput('TodoWrite', { todos: [{}] }),
    '1 item'
  );
});

test('summarizeToolInput: Task shows subagent_type and description', () => {
  const result = summarizeToolInput('Task', {
    subagent_type: 'generalPurpose',
    description: 'Run tests and fix failures',
  });
  assert.ok(result.includes('generalPurpose'));
  assert.ok(result.includes('Run tests'));
});

test('summarizeToolInput: unknown tool returns empty string', () => {
  assert.equal(summarizeToolInput('UnknownTool', { foo: 'bar' }), '');
});

// ── OpenClaw-specific (lowercase) tools ───────────────────────────────────────

test('summarizeToolInput: OpenClaw read returns basename from path field', () => {
  assert.equal(summarizeToolInput('read', { path: '/workspace/src/auth.ts' }), 'auth.ts');
});

test('summarizeToolInput: OpenClaw read returns basename from file field', () => {
  assert.equal(summarizeToolInput('read', { file: '/workspace/src/main.ts' }), 'main.ts');
});

test('summarizeToolInput: OpenClaw write returns basename', () => {
  assert.equal(summarizeToolInput('write', { path: '/workspace/config.json' }), 'config.json');
});

test('summarizeToolInput: OpenClaw exec returns truncated command', () => {
  assert.equal(summarizeToolInput('exec', { command: 'npm test' }), 'npm test');
  const long = 'x'.repeat(60);
  assert.ok(summarizeToolInput('exec', { command: long }).endsWith('…'));
});

test('summarizeToolInput: OpenClaw web_search returns truncated query', () => {
  const result = summarizeToolInput('web_search', { query: 'OpenClaw agent observability' });
  assert.ok(result.includes('OpenClaw'));
});

test('summarizeToolInput: OpenClaw web_fetch returns url', () => {
  assert.ok(summarizeToolInput('web_fetch', { url: 'https://example.com' }).includes('example.com'));
});

test('summarizeToolInput: OpenClaw memory_search returns query', () => {
  assert.equal(summarizeToolInput('memory_search', { query: 'user preferences' }), 'user preferences');
});

test('summarizeToolInput: OpenClaw memory_get returns path', () => {
  assert.equal(summarizeToolInput('memory_get', { path: 'preferences.md' }), 'preferences.md');
});

test('summarizeToolInput: OpenClaw message formats action + provider + to', () => {
  const result = summarizeToolInput('message', {
    action: 'send',
    provider: 'feishu',
    to: 'ou_abc123',
  });
  assert.ok(result.includes('send'));
  assert.ok(result.includes('feishu'));
  assert.ok(result.includes('ou_abc123'));
});

test('summarizeToolInput: OpenClaw sessions_spawn uses label and task', () => {
  const result = summarizeToolInput('sessions_spawn', {
    label: 'coder',
    task: 'Run the test suite and fix all failures',
    agentId: 'agent_1',
  });
  assert.ok(result.includes('coder'));
  assert.ok(result.includes('Run the test suite'));
});

// ── entryToLiveEvents ─────────────────────────────────────────────────────────

function makeCtx() {
  return { turnCounter: 0 };
}

test('entryToLiveEvents: session entry emits session_start and resets counter', () => {
  const ctx = makeCtx();
  ctx.turnCounter = 5;
  const entry: JournalEntry = { type: 'session', id: 's1', cwd: '/tmp', timestamp: '2026-01-01T00:00:00Z' };
  const events = entryToLiveEvents(entry, ctx);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.kind, 'session_start');
  assert.equal(ctx.turnCounter, 0);
});

test('entryToLiveEvents: user message emits turn_start with incremented counter', () => {
  const ctx = makeCtx();
  const entry: JournalEntry = {
    type: 'message',
    id: 'u1',
    parentId: 's1',
    timestamp: '2026-01-01T00:00:01Z',
    message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    role: 'user',
    content: 'hello',
  };
  const events = entryToLiveEvents(entry, ctx);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.kind, 'turn_start');
  assert.equal(events[0]!.turnIndex, 1);
  assert.equal(ctx.turnCounter, 1);
});

test('entryToLiveEvents: assistant with toolCall emits tool_call events', () => {
  const ctx = makeCtx();
  const entry: JournalEntry = {
    type: 'message',
    id: 'a1',
    parentId: 'u1',
    timestamp: '2026-01-01T00:00:02Z',
    message: {
      role: 'assistant',
      model: 'moonshot/kimi-k2.5',
      content: [
        { type: 'toolCall', name: 'Read', id: 'tc1', input: { path: '/src/auth.ts' } },
        { type: 'toolCall', name: 'Edit', id: 'tc2', input: { path: '/src/auth.ts' } },
      ],
    },
    role: 'assistant',
    content: '',
  };
  const events = entryToLiveEvents(entry, ctx);
  assert.equal(events.length, 2);
  assert.equal(events[0]!.kind, 'tool_call');
  assert.equal(events[0]!.tool, 'Read');
  assert.equal(events[0]!.toolSummary, 'auth.ts');
  assert.equal(events[1]!.kind, 'tool_call');
  assert.equal(events[1]!.tool, 'Edit');
  assert.equal(events[1]!.model, 'moonshot/kimi-k2.5');
});

test('entryToLiveEvents: assistant without toolCall emits turn_end', () => {
  const ctx = makeCtx();
  const entry: JournalEntry = {
    type: 'message',
    id: 'a1',
    parentId: 'u1',
    timestamp: '2026-01-01T00:00:05Z',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Done.' }],
      usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, totalTokens: 1200 },
    },
    role: 'assistant',
    content: 'Done.',
  };
  const events = entryToLiveEvents(entry, ctx);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.kind, 'turn_end');
  assert.equal(events[0]!.tokensOut, 200);
});

test('entryToLiveEvents: Task tool emits subagent_start', () => {
  const ctx = makeCtx();
  const entry: JournalEntry = {
    type: 'message',
    id: 'a1',
    parentId: 'u1',
    timestamp: '2026-01-01T00:00:03Z',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          name: 'Task',
          id: 'tc1',
          input: { subagent_type: 'generalPurpose', description: 'Run tests' },
        },
      ],
    },
    role: 'assistant',
    content: '',
  };
  const events = entryToLiveEvents(entry, ctx);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.kind, 'subagent_start');
  assert.equal(events[0]!.tool, 'Task');
  assert.ok(events[0]!.toolSummary?.includes('generalPurpose'));
});

test('entryToLiveEvents: OpenClaw sessions_spawn emits subagent_start', () => {
  const ctx = makeCtx();
  const entry: JournalEntry = {
    type: 'message',
    id: 'a1',
    parentId: 'u1',
    timestamp: '2026-01-01T00:00:03Z',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          name: 'sessions_spawn',
          id: 'tc1',
          input: { label: 'coder', task: 'Run tests and fix failures', agentId: 'agent_2' },
        },
      ],
    },
    role: 'assistant',
    content: '',
  };
  const events = entryToLiveEvents(entry, ctx);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.kind, 'subagent_start');
  assert.equal(events[0]!.tool, 'sessions_spawn');
  assert.ok(events[0]!.toolSummary?.includes('coder'));
});

test('entryToLiveEvents: toolResult without error emits tool_result with toolError=false', () => {
  const ctx = makeCtx();
  const entry: JournalEntry = {
    type: 'message',
    id: 'r1',
    parentId: 'a1',
    timestamp: '2026-01-01T00:00:04Z',
    message: {
      role: 'toolResult',
      content: [{ type: 'toolResult', toolUseId: 'tc1', content: 'ok' }],
    },
    role: 'toolResult',
    content: '',
  };
  const events = entryToLiveEvents(entry, ctx);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.kind, 'tool_result');
  assert.equal(events[0]!.toolError, false);
});

test('entryToLiveEvents: toolResult with error emits tool_result with toolError=true', () => {
  const ctx = makeCtx();
  const entry: JournalEntry = {
    type: 'message',
    id: 'r1',
    parentId: 'a1',
    timestamp: '2026-01-01T00:00:04Z',
    message: {
      role: 'toolResult',
      content: [{ type: 'toolResult', toolUseId: 'tc1', isError: true, content: 'Command failed' }],
    },
    role: 'toolResult',
    content: '',
  };
  const events = entryToLiveEvents(entry, ctx);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.kind, 'tool_result');
  assert.equal(events[0]!.toolError, true);
});

test('entryToLiveEvents: compaction emits compaction event', () => {
  const ctx = makeCtx();
  const entry: JournalEntry = {
    type: 'compaction',
    id: 'c1',
    parentId: 'a1',
    firstKeptEntryId: 'u2',
    timestamp: '2026-01-01T00:01:00Z',
  };
  const events = entryToLiveEvents(entry, ctx);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.kind, 'compaction');
});

test('entryToLiveEvents: delivery-mirror assistant entries are skipped', () => {
  const ctx = makeCtx();
  const entry: JournalEntry = {
    type: 'message',
    id: 'a1',
    parentId: 'u1',
    timestamp: '2026-01-01T00:00:02Z',
    message: {
      role: 'assistant',
      model: 'delivery-mirror',
      provider: 'openclaw',
      content: [{ type: 'text', text: 'mirrored reply' }],
    },
    role: 'assistant',
    content: 'mirrored reply',
  };
  const events = entryToLiveEvents(entry, ctx);
  assert.equal(events.length, 0);
});

// ── findMostRecentJsonl ───────────────────────────────────────────────────────

test('findMostRecentJsonl: returns null when dir is empty', () => {
  const fixture = createFixture();
  try {
    const result = findMostRecentJsonl(fixture.sessionsDir);
    assert.equal(result, null);
  } finally {
    cleanupFixture(fixture);
  }
});

test('findMostRecentJsonl: returns the most recently modified jsonl file', async () => {
  const fixture = createFixture();
  try {
    // Write first file
    writeTranscript(fixture, 'older', [
      { type: 'session', id: 's1', cwd: '/tmp', timestamp: 1 },
    ]);

    // Wait briefly so mtimes differ
    await new Promise<void>((r) => setTimeout(r, 20));

    // Write second (newer) file
    const newerPath = writeTranscript(fixture, 'newer', [
      { type: 'session', id: 's2', cwd: '/tmp', timestamp: 2 },
    ]);

    const result = findMostRecentJsonl(fixture.sessionsDir);
    assert.ok(result !== null);
    assert.equal(result, newerPath);
  } finally {
    cleanupFixture(fixture);
  }
});

test('findMostRecentJsonl: returns null for non-existent directory', () => {
  const result = findMostRecentJsonl('/tmp/clawprobe-nonexistent-dir-xyz');
  assert.equal(result, null);
});

// ── startLiveStream integration ───────────────────────────────────────────────

test('startLiveStream: emits events for appended JSONL content', async () => {
  const fixture = createFixture();
  try {
    const filePath = writeTranscript(fixture, 'live-test', [
      { type: 'session', id: 's1', cwd: '/tmp', timestamp: 1000 },
    ]);

    const collected: string[] = [];
    const controller = new AbortController();

    // Start stream with skipHistory=false to include existing content
    const streamPromise = startLiveStream(
      filePath,
      (event) => { collected.push(event.kind); },
      controller.signal,
      false  // replay from beginning
    );

    // Give the stream time to read the initial session entry
    await new Promise<void>((r) => setTimeout(r, 150));

    // Append a user message
    fs.appendFileSync(filePath, JSON.stringify({
      type: 'message',
      id: 'u1',
      parentId: 's1',
      timestamp: 2000,
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    }) + '\n');

    // Wait for poll cycle to pick it up
    await new Promise<void>((r) => setTimeout(r, 200));

    // Append an assistant message with a tool call
    fs.appendFileSync(filePath, JSON.stringify({
      type: 'message',
      id: 'a1',
      parentId: 'u1',
      timestamp: 3000,
      message: {
        role: 'assistant',
        content: [
          { type: 'toolCall', name: 'Read', id: 'tc1', input: { path: '/src/main.ts' } },
        ],
      },
    }) + '\n');

    // Wait for poll to pick up the assistant message
    await new Promise<void>((r) => setTimeout(r, 200));

    controller.abort();

    // Ensure the promise resolves cleanly after abort
    await streamPromise;

    assert.ok(collected.includes('session_start'), `expected session_start, got: ${collected.join(',')}`);
    assert.ok(collected.includes('turn_start'),    `expected turn_start, got: ${collected.join(',')}`);
    assert.ok(collected.includes('thinking'),      `expected thinking, got: ${collected.join(',')}`);
    assert.ok(collected.includes('tool_call'),     `expected tool_call, got: ${collected.join(',')}`);
  } finally {
    cleanupFixture(fixture);
  }
});

test('startLiveStream: skipHistory=true ignores existing content', async () => {
  const fixture = createFixture();
  try {
    // Write a complete turn before starting the stream
    const filePath = writeTranscript(fixture, 'skip-test', [
      { type: 'session', id: 's1', cwd: '/tmp', timestamp: 1000 },
      {
        type: 'message',
        id: 'u1',
        parentId: 's1',
        timestamp: 2000,
        message: { role: 'user', content: [{ type: 'text', text: 'old message' }] },
      },
      {
        type: 'message',
        id: 'a1',
        parentId: 'u1',
        timestamp: 3000,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'old reply' }],
          usage: { input: 500, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 600 },
        },
      },
    ]);

    const collected: string[] = [];
    const controller = new AbortController();

    // Start with skipHistory=true (default)
    const streamPromise = startLiveStream(
      filePath,
      (event) => { collected.push(event.kind); },
      controller.signal,
      true  // skip existing history
    );

    // Give stream time to fast-forward
    await new Promise<void>((r) => setTimeout(r, 150));

    // Append a new user message AFTER stream started
    fs.appendFileSync(filePath, JSON.stringify({
      type: 'message',
      id: 'u2',
      parentId: 'a1',
      timestamp: 4000,
      message: { role: 'user', content: [{ type: 'text', text: 'new message' }] },
    }) + '\n');

    await new Promise<void>((r) => setTimeout(r, 200));

    controller.abort();
    await streamPromise;

    // Should NOT include events from the pre-existing history
    assert.ok(!collected.includes('session_start'), 'should not replay session_start');
    assert.ok(!collected.includes('turn_end'),      'should not replay old turn_end');
    // Should include the new turn
    assert.ok(collected.includes('turn_start'),     `expected new turn_start, got: ${collected.join(',')}`);
    assert.ok(collected.includes('thinking'),       `expected thinking, got: ${collected.join(',')}`);
  } finally {
    cleanupFixture(fixture);
  }
});
