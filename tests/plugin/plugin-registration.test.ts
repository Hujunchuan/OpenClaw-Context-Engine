import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
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

test('plugin registers both legacy context-engine and hook bridge handlers when runtime exposes both APIs', async () => {
  const registrations: Array<{ id: string; factory: () => unknown | Promise<unknown> }> = [];
  const hooks = new Map<string, (...args: unknown[]) => unknown>();

  register({
    registerContextEngine(id, factory) {
      registrations.push({ id, factory });
    },
    on(hookName, handler) {
      hooks.set(hookName, handler);
    },
  });

  assert.equal(registrations.length, 1);
  assert.equal(registrations[0]?.id, 'hypergraph-context-engine');
  assert.equal(typeof hooks.get('before_agent_start'), 'function');
  assert.equal(typeof hooks.get('agent_end'), 'function');
  assert.equal(typeof hooks.get('before_compaction'), 'function');
});

test('plugin skips hook bridge registration when it is the active contextEngine slot', async () => {
  const registrations: Array<{ id: string; factory: () => unknown | Promise<unknown> }> = [];
  const hooks = new Map<string, (...args: unknown[]) => unknown>();

  register({
    config: {
      plugins: {
        slots: {
          contextEngine: 'hypergraph-context-engine',
        },
      },
    },
    registerContextEngine(id, factory) {
      registrations.push({ id, factory });
    },
    on(hookName, handler) {
      hooks.set(hookName, handler);
    },
  });

  assert.equal(registrations.length, 1);
  assert.equal(registrations[0]?.id, 'hypergraph-context-engine');
  assert.equal(hooks.size, 0);
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
  assert.equal((assembled.messages as Array<Record<string, unknown>>).at(-1)?.id, toyTranscript.at(-1)?.id);
  assert.ok((assembled.messages?.length ?? 0) <= toyTranscript.length);
  assert.ok(
    assembled.messages.every((message: Record<string, unknown>) =>
      (message.source ?? undefined) === undefined && !('kind' in message)),
  );
});

test('plugin assemble ignores its own injected context messages during runtime sync', async () => {
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
    sessionKey: 'chat-ignore-plugin-source',
    messages: [
      {
        id: 'ctx-1',
        role: 'assistant',
        content: 'Recovered context that should not become transcript history.',
        source: 'hypergraph-context-engine',
        createdAt: new Date().toISOString(),
      },
    ],
    tokenBudget: 320,
  });

  assert.equal((assembled.messages?.length ?? 0), 0);
  assert.match(assembled.systemPromptAddition ?? '', /no session snapshot yet|fallback/i);
});

test('plugin ingestBatch ignores plugin-injected runtime context messages', async () => {
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
    assemble: Function;
  };

  const ingested = await engine.ingestBatch({
    sessionId: 'turn-1',
    sessionKey: 'chat-ignore-plugin-source-batch',
    messages: [
      {
        id: 'ctx-1',
        role: 'assistant',
        content: 'Recovered context that should not become transcript history.',
        source: 'hypergraph-context-engine',
        createdAt: new Date().toISOString(),
      },
    ],
  });

  const assembled = await engine.assemble({
    sessionId: 'turn-1',
    sessionKey: 'chat-ignore-plugin-source-batch',
    messages: [],
    tokenBudget: 320,
  });

  assert.equal(ingested.ingestedCount, 0);
  assert.equal((assembled.messages?.length ?? 0), 0);
  assert.match(assembled.systemPromptAddition ?? '', /no session snapshot yet|fallback/i);
});

test('plugin ignores synthetic hook-bridge context text even when runtime does not preserve source metadata', async () => {
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

  const bridgeMessage = {
    id: 'bridge-1',
    role: 'user',
    content: `[Hypergraph Context Bridge]

HypergraphContextEngine fallback assemble: no session snapshot yet, using empty task state.

Recovered context:
- user: Current task: stale bridge text should not be persisted.`,
    createdAt: '2026-03-26T00:00:00.000Z',
  };
  const userMessage = {
    id: 'u1',
    role: 'user',
    content: 'Current task: reconnect hypergraph context engine. Next step: confirm scoped memory files are written.',
    createdAt: '2026-03-26T00:00:05.000Z',
  };

  const assembled = await engine.assemble({
    sessionId: 'hook-bridge-filter-session',
    sessionKey: 'hook-bridge-filter-session',
    messages: [bridgeMessage, userMessage],
    tokenBudget: 320,
  });

  assert.equal(
    assembled.messages.some((message: Record<string, unknown>) => message.id === 'bridge-1'),
    false,
  );
  assert.ok(
    assembled.messages.some((message: Record<string, unknown>) => message.id === 'u1'),
  );
  assert.match(assembled.systemPromptAddition ?? '', /reconnect hypergraph context engine/i);
  assert.doesNotMatch(assembled.systemPromptAddition ?? '', /stale bridge text should not be persisted/i);
});

test('plugin assemble keeps real previous user dialogue available for follow-up questions', async () => {
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

  const t1 = {
    id: 'u1',
    role: 'user',
    content: 'Remember this exactly: current task is long-dialogue memory test. First keywords are alpha-123 and beta-456.',
    createdAt: '2026-03-23T09:00:00.000Z',
  };
  const t2 = {
    id: 'u2',
    role: 'user',
    content: 'Also remember this second sentence exactly: second keywords are gamma-789.',
    createdAt: '2026-03-23T09:01:00.000Z',
  };
  const t3 = {
    id: 'u3',
    role: 'user',
    content: 'What did I say in the previous message? Answer with only that previous message.',
    createdAt: '2026-03-23T09:02:00.000Z',
  };

  await engine.assemble({
    sessionId: 'turn-1',
    sessionKey: 'chat-prev-message',
    messages: [t1],
    tokenBudget: 320,
  });

  await engine.assemble({
    sessionId: 'turn-2',
    sessionKey: 'chat-prev-message',
    messages: [t1, t2],
    tokenBudget: 320,
  });

  const assembled = await engine.assemble({
    sessionId: 'turn-3',
    sessionKey: 'chat-prev-message',
    messages: [t1, t2, t3],
    tokenBudget: 420,
  });

  assert.ok(
    assembled.messages.some((message: Record<string, unknown>) =>
      message.role === 'user' && message.content === t2.content),
    'assemble should keep the actual previous user message available as runtime context',
  );
  assert.ok(
    assembled.messages.some((message: Record<string, unknown>) =>
      message.role === 'user' && message.content === t1.content),
    'conversation recall should keep the first user message when it may be needed for follow-up recall',
  );
  assert.match(assembled.systemPromptAddition ?? '', /Immediate previous user message:/);
  assert.ok(
    assembled.messages.every((message: Record<string, unknown>) =>
      !('kind' in message)
      && (message.source === undefined || message.source !== 'hypergraph-context-engine')),
    'contextEngine slot mode should preserve runtime dialogue messages instead of injecting synthetic ones into session history',
  );
});

test('slot-safe assemble filters non-canonical runtime messages while keeping recent dialogue', async () => {
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
    sessionId: 'slot-safe-chat',
    sessionKey: 'slot-safe-chat',
    messages: [
      {
        id: 'sys-1',
        role: 'system',
        content: 'Runtime system prompt',
        createdAt: '2026-03-23T08:59:00.000Z',
      },
      {
        id: 'u1',
        role: 'user',
        content: 'Remember alpha and beta',
        createdAt: '2026-03-23T09:00:00.000Z',
      },
      {
        id: 'ctx-1',
        role: 'assistant',
        content: 'Recovered context should never re-enter the canonical session history',
        source: 'hypergraph-context-engine',
        createdAt: '2026-03-23T09:00:30.000Z',
      },
      {
        id: 'tool-1',
        role: 'assistant',
        type: 'tool_result',
        content: 'Tool output',
        createdAt: '2026-03-23T09:01:00.000Z',
      },
      {
        id: 'u2',
        role: 'user',
        content: 'What did I say in the previous message?',
        createdAt: '2026-03-23T09:02:00.000Z',
      },
    ],
    tokenBudget: 420,
  });

  const ids = assembled.messages.map((message: Record<string, unknown>) => message.id);
  assert.deepEqual(ids, ['sys-1', 'u1', 'tool-1', 'u2']);
  assert.ok(assembled.messages.every((message: Record<string, unknown>) => message.source === undefined));
  assert.equal((assembled.messages.find((message: Record<string, unknown>) => message.id === 'tool-1') as Record<string, unknown>)?.type, 'tool_result');
});

test('slot-safe assemble keeps task-definition turns for current-task continuation prompts', async () => {
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
    sessionId: 'slot-safe-current-task',
    sessionKey: 'slot-safe-current-task',
    messages: [
      {
        id: 'u1',
        role: 'user',
        content: 'Current task: stabilize slot-safe context assembly for long conversations.',
        createdAt: '2026-03-23T09:00:00.000Z',
      },
      {
        id: 'u2',
        role: 'user',
        content: 'Next step: verify the current-task recall path still prefers the real task definition over the recall question.',
        createdAt: '2026-03-23T09:01:00.000Z',
      },
      {
        id: 'a1',
        role: 'assistant',
        content: 'I will keep semantic augmentation inside systemPromptAddition.',
        createdAt: '2026-03-23T09:02:00.000Z',
      },
      {
        id: 'u3',
        role: 'user',
        content: 'What is the current task and next step?',
        createdAt: '2026-03-23T09:03:00.000Z',
      },
    ],
    tokenBudget: 420,
  });

  assert.ok(
    assembled.messages.some((message: Record<string, unknown>) => message.id === 'u1'),
    'continuation prompts should keep the latest non-recall user task definition turn',
  );
  assert.ok(
    assembled.messages.some((message: Record<string, unknown>) => message.id === 'u2'),
    'continuation prompts should keep the latest user-defined next-step turn',
  );
  assert.match(assembled.systemPromptAddition ?? '', /Latest task-defining user message:/);
  assert.match(assembled.systemPromptAddition ?? '', /Latest user-defined next step:/);
  assert.match(assembled.systemPromptAddition ?? '', /do not run memory_search or memory_get against global or cross-session memory/i);
});

test('slot-safe assemble blocks long-term memory tool recall for explicit task seed declarations', async () => {
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
    sessionId: 'slot-safe-seed-task',
    sessionKey: 'slot-safe-seed-task',
    messages: [
      {
        id: 'u1',
        role: 'user',
        content: 'Current task: alpha session isolation test. Next step: verify alpha session stays isolated.',
        createdAt: '2026-03-24T13:00:00.000Z',
      },
    ],
    tokenBudget: 320,
  });

  assert.match(assembled.systemPromptAddition ?? '', /do not run memory_search or memory_get/i);
  assert.match(assembled.systemPromptAddition ?? '', /Do not consult MEMORY\.md, memory\/\*\.md, or unrelated long-term memory/i);
  assert.match(assembled.systemPromptAddition ?? '', /Treat this turn as the canonical task definition for the current session/i);
  assert.match(assembled.systemPromptAddition ?? '', /state update, not a request to execute, verify, inspect sessions, or investigate memory/i);
  assert.match(assembled.systemPromptAddition ?? '', /do not call tools, do not inspect other sessions, do not update MEMORY\.md/i);
  assert.match(assembled.systemPromptAddition ?? '', /Do not begin the declared next step now/i);
  assert.match(assembled.systemPromptAddition ?? '', /Preferred reply for this turn: one short acknowledgement/i);
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

  assert.equal(existsSync(join(flushOnDir, '.hypergraph-memory', 'session', 'turn-1', 'SESSION_NOW.md')), true);
  assert.equal(existsSync(join(flushOffDir, '.hypergraph-memory', 'session', 'turn-1', 'SESSION_NOW.md')), false);
});

test('plugin runtime identity debug writes canonical namespace diagnostics using explicit session ids', async () => {
  const registrations: Array<{ id: string; factory: (runtimeConfig?: unknown) => unknown | Promise<unknown> }> = [];
  const tempDir = mkdtempSync(join(tmpdir(), 'openclaw-context-engine-identity-debug-'));

  register({
    registerContextEngine(id, factory) {
      registrations.push({ id, factory });
    },
  });

  const engine = await registrations[0]!.factory({
    disablePersistence: true,
    memoryWorkspaceRoot: tempDir,
    runtimeIdentityDebug: true,
    flushOnAfterTurn: true,
  }) as {
    afterTurn: Function;
  };

  await engine.afterTurn({
    sessionId: 'explicit-session-alpha',
    sessionKey: 'agent:main:main',
    sessionFile: join(tempDir, 'sessions', 'explicit-session-alpha.jsonl'),
    runtimeContext: {
      workspaceDir: join(tempDir, 'workspace-alpha'),
    },
    messages: toyTranscript.map((entry) => ({
      ...entry,
      role: entry.role ?? entry.type,
    })),
    prePromptMessageCount: 0,
  });

  const debugLog = readFileSync(join(tempDir, 'runtime-identity-debug.log'), 'utf8');
  assert.match(debugLog, /"sessionId":"explicit-session-alpha"/);
  assert.match(debugLog, /"sources":\{"sessionId":"sessionId"/);
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

  assert.equal(existsSync(join(tempDir, '.hypergraph-memory', 'session', 'turn-1', 'SESSION_NOW.md')), true);
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

  assert.equal(existsSync(join(tempDir, '.hypergraph-memory', 'session', 'hook-chat', 'SESSION_NOW.md')), true);

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
