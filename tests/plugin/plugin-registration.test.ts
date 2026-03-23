import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { toyTranscript } from '../../fixtures/toy-transcript.js';
import register from '../../index.js';

test('plugin registers a context engine under the manifest id', async () => {
  const registrations: Array<{ id: string; factory: () => unknown | Promise<unknown> }> = [];

  register({
    registerContextEngine(id, factory) {
      registrations.push({ id, factory });
    },
  });

  assert.equal(registrations.length, 1);
  assert.equal(registrations[0]?.id, 'hypergraph-context-engine');

  const engine = await registrations[0]!.factory() as {
    info: { id: string; name: string };
    ingest: Function;
    assemble: Function;
    compact: Function;
    afterTurn: Function;
  };

  assert.equal(engine.info.id, 'hypergraph-context-engine');
  assert.equal(typeof engine.ingest, 'function');
  assert.equal(typeof engine.assemble, 'function');
  assert.equal(typeof engine.compact, 'function');
  assert.equal(typeof engine.afterTurn, 'function');
});

test('plugin reuses persisted session state across fresh runtime engine instances', async () => {
  const registrations: Array<{ id: string; factory: (runtimeConfig?: unknown) => unknown | Promise<unknown> }> = [];
  const tempDir = mkdtempSync(join(tmpdir(), 'openclaw-context-engine-test-'));
  const dbPath = join(tempDir, 'hypergraph-context-engine.sqlite');

  register({
    registerContextEngine(id, factory) {
      registrations.push({ id, factory });
    },
  });

  const firstEngine = await registrations[0]!.factory({ dbPath }) as {
    ingestBatch: Function;
    assemble: Function;
  };
  await firstEngine.ingestBatch({
    sessionId: 'turn-1',
    sessionKey: 'chat-123',
    messages: toyTranscript.map((entry) => ({
      ...entry,
      role: entry.role ?? entry.type,
    })),
  });

  const secondEngine = await registrations[0]!.factory({ dbPath }) as {
    assemble: Function;
  };
  const assembled = await secondEngine.assemble({
    sessionId: 'turn-2',
    sessionKey: 'chat-123',
    messages: [
      ...toyTranscript.map((entry) => ({
        ...entry,
        role: entry.role ?? entry.type,
      })),
      {
        id: 'turn-2-user',
        role: 'user',
        content: '继续做 sqlite 这块，别忘了前面做到哪了',
        createdAt: new Date().toISOString(),
      },
    ],
    tokenBudget: 400,
  });

  assert.ok((assembled.messages?.length ?? 0) > 0);
  assert.match(assembled.systemPromptAddition ?? '', /Intent:/);
});

test('plugin assemble can bootstrap state directly from runtime messages without a prior ingest call', async () => {
  const registrations: Array<{ id: string; factory: (runtimeConfig?: unknown) => unknown | Promise<unknown> }> = [];

  register({
    registerContextEngine(id, factory) {
      registrations.push({ id, factory });
    },
  });

  const engine = await registrations[0]!.factory({
    disablePersistence: true,
  }) as {
    assemble: Function;
  };

  const assembled = await engine.assemble({
    sessionId: 'turn-1',
    sessionKey: 'chat-bootstrap',
    messages: toyTranscript.map((entry) => ({
      ...entry,
      role: entry.role ?? entry.type,
    })),
    tokenBudget: 400,
  });

  assert.ok((assembled.messages?.length ?? 0) > 0);
  assert.match(assembled.systemPromptAddition ?? '', /Intent:/);
  assert.doesNotMatch(assembled.systemPromptAddition ?? '', /no session snapshot yet/i);
});

test('plugin compact returns OpenClaw-compatible compaction metadata', async () => {
  const registrations: Array<{ id: string; factory: (runtimeConfig?: unknown) => unknown | Promise<unknown> }> = [];

  register({
    registerContextEngine(id, factory) {
      registrations.push({ id, factory });
    },
  });

  const engine = await registrations[0]!.factory({
    disablePersistence: true,
  }) as {
    ingestBatch: Function;
    compact: Function;
  };

  await engine.ingestBatch({
    sessionId: 'turn-1',
    sessionKey: 'chat-compact',
    messages: toyTranscript.map((entry) => ({
      ...entry,
      role: entry.role ?? entry.type,
    })),
  });

  const compacted = await engine.compact({
    sessionId: 'turn-1',
    sessionKey: 'chat-compact',
    sessionFile: 'session.jsonl',
    currentTokenCount: 999,
  });

  assert.equal(compacted.ok, true);
  assert.equal(compacted.compacted, true);
  assert.match(compacted.result?.summary ?? '', /Structured summary emitted/);
  assert.match(compacted.result?.firstKeptEntryId ?? '', /u\d|a\d|t\d/i);
  assert.ok((compacted.result?.tokensBefore ?? 0) > 0);
  if (compacted.result?.tokensAfter != null) {
    assert.ok(compacted.result.tokensAfter > 0);
    assert.ok(compacted.result.tokensAfter < (compacted.result?.tokensBefore ?? Number.MAX_SAFE_INTEGER));
  }
});

test('plugin runtime config flushOnAfterTurn controls whether afterTurn writes layered memory', async () => {
  const registrations: Array<{ id: string; factory: (runtimeConfig?: unknown) => unknown | Promise<unknown> }> = [];
  const flushOnDir = mkdtempSync(join(tmpdir(), 'openclaw-context-engine-flush-on-'));
  const flushOffDir = mkdtempSync(join(tmpdir(), 'openclaw-context-engine-flush-off-'));

  register({
    registerContextEngine(id, factory) {
      registrations.push({ id, factory });
    },
  });

  const enabled = await registrations[0]!.factory({
    disablePersistence: true,
    memoryWorkspaceRoot: flushOnDir,
    flushOnAfterTurn: true,
    enableLayeredRead: true,
    enableLayeredWrite: true,
    promoteOnMaintenance: false,
  }) as {
    afterTurn: Function;
  };
  const disabled = await registrations[0]!.factory({
    disablePersistence: true,
    memoryWorkspaceRoot: flushOffDir,
    flushOnAfterTurn: false,
    enableLayeredRead: true,
    enableLayeredWrite: true,
    promoteOnMaintenance: false,
  }) as {
    afterTurn: Function;
  };

  await enabled.afterTurn({
    sessionId: 'turn-1',
    sessionKey: 'flush-on-chat',
    sessionFile: 'session.jsonl',
    messages: toyTranscript.map((entry) => ({
      ...entry,
      role: entry.role ?? entry.type,
    })),
    prePromptMessageCount: 0,
  });
  await disabled.afterTurn({
    sessionId: 'turn-1',
    sessionKey: 'flush-off-chat',
    sessionFile: 'session.jsonl',
    messages: toyTranscript.map((entry) => ({
      ...entry,
      role: entry.role ?? entry.type,
    })),
    prePromptMessageCount: 0,
  });

  assert.equal(existsSync(join(flushOnDir, 'NOW.md')), true);
  assert.equal(existsSync(join(flushOffDir, 'NOW.md')), false);
});

test('legacy context-engine registration falls back to pluginConfig when runtime config omits plugin settings', async () => {
  const registrations: Array<{ id: string; factory: (runtimeConfig?: unknown) => unknown | Promise<unknown> }> = [];
  const tempDir = mkdtempSync(join(tmpdir(), 'openclaw-context-engine-plugin-config-'));

  register({
    pluginConfig: {
      disablePersistence: true,
      memoryWorkspaceRoot: tempDir,
      flushOnAfterTurn: true,
      flushOnCompact: true,
      promoteOnMaintenance: false,
    },
    registerContextEngine(id, factory) {
      registrations.push({ id, factory });
    },
  });

  const engine = await registrations[0]!.factory({}) as {
    afterTurn: Function;
  };

  await engine.afterTurn({
    sessionId: 'turn-1',
    sessionKey: 'plugin-config-chat',
    sessionFile: 'session.jsonl',
    messages: toyTranscript.map((entry) => ({
      ...entry,
      role: entry.role ?? entry.type,
    })),
    prePromptMessageCount: 0,
  });

  assert.equal(existsSync(join(tempDir, 'NOW.md')), true);
});

test('plugin runtime config disablePersistence controls cross-instance resume behavior', async () => {
  const registrations: Array<{ id: string; factory: (runtimeConfig?: unknown) => unknown | Promise<unknown> }> = [];
  const tempDir = mkdtempSync(join(tmpdir(), 'openclaw-context-engine-persist-'));
  const dbPath = join(tempDir, 'runtime.sqlite');

  register({
    registerContextEngine(id, factory) {
      registrations.push({ id, factory });
    },
  });

  const persistentWriter = await registrations[0]!.factory({
    disablePersistence: false,
    dbPath,
    memoryWorkspaceRoot: join(tempDir, 'persistent-memory'),
    flushOnAfterTurn: false,
    flushOnCompact: false,
  }) as {
    ingestBatch: Function;
  };
  await persistentWriter.ingestBatch({
    sessionId: 'turn-1',
    sessionKey: 'persist-chat',
    messages: toyTranscript.map((entry) => ({
      ...entry,
      role: entry.role ?? entry.type,
    })),
  });

  const persistentReader = await registrations[0]!.factory({
    disablePersistence: false,
    dbPath,
    memoryWorkspaceRoot: join(tempDir, 'persistent-memory'),
    flushOnAfterTurn: false,
    flushOnCompact: false,
  }) as {
    assemble: Function;
  };
  const persistentAssembled = await persistentReader.assemble({
    sessionId: 'turn-2',
    sessionKey: 'persist-chat',
    messages: [],
    tokenBudget: 400,
  });

  const inMemoryReader = await registrations[0]!.factory({
    disablePersistence: true,
    memoryWorkspaceRoot: join(tempDir, 'ephemeral-memory'),
    flushOnAfterTurn: false,
    flushOnCompact: false,
  }) as {
    assemble: Function;
  };
  const inMemoryAssembled = await inMemoryReader.assemble({
    sessionId: 'turn-2',
    sessionKey: 'fresh-chat',
    messages: [],
    tokenBudget: 400,
  });

  assert.equal(existsSync(dbPath), true);
  assert.ok((persistentAssembled.messages?.length ?? 0) > 0);
  assert.match(persistentAssembled.systemPromptAddition ?? '', /Intent:/);
  assert.equal((inMemoryAssembled.messages?.length ?? 0), 0);
  assert.match(inMemoryAssembled.systemPromptAddition ?? '', /no session snapshot yet|fallback/i);
});

test('plugin can register an OpenClaw hook bridge and prepend assembled context', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'openclaw-context-engine-hook-bridge-'));
  const hooks = new Map<string, (...args: unknown[]) => unknown>();

  register({
    pluginConfig: {
      disablePersistence: true,
      memoryWorkspaceRoot: tempDir,
      flushOnAfterTurn: true,
      flushOnCompact: true,
      promoteOnMaintenance: false,
    },
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    on(hookName, handler) {
      hooks.set(hookName, handler);
    },
  });

  assert.equal(typeof hooks.get('before_agent_start'), 'function');
  assert.equal(typeof hooks.get('agent_end'), 'function');
  assert.equal(typeof hooks.get('before_compaction'), 'function');

  const beforeAgentStart = hooks.get('before_agent_start')!;
  const hookResult = await beforeAgentStart(
    {
      prompt: '继续修复 runtime lifecycle',
      messages: toyTranscript.map((entry) => ({
        ...entry,
        role: entry.role ?? entry.type,
      })),
    },
    {
      sessionKey: 'hook-chat',
      agentId: 'agent-hook',
    },
  ) as { prependContext?: string } | undefined;

  assert.match(hookResult?.prependContext ?? '', /\[Hypergraph Context Bridge\]/);
  assert.match(hookResult?.prependContext ?? '', /Intent:/);

  const agentEnd = hooks.get('agent_end')!;
  await agentEnd(
    {
      success: true,
      messages: toyTranscript.map((entry) => ({
        ...entry,
        role: entry.role ?? entry.type,
      })),
    },
    {
      sessionKey: 'hook-chat',
      agentId: 'agent-hook',
    },
  );

  assert.equal(existsSync(join(tempDir, 'NOW.md')), true);

  const beforeCompaction = hooks.get('before_compaction')!;
  await beforeCompaction(
    {
      messageCount: toyTranscript.length,
      tokenCount: 512,
    },
    {
      sessionKey: 'hook-chat',
      agentId: 'agent-hook',
    },
  );

  assert.equal(existsSync(join(tempDir, 'memory')), true);
});
