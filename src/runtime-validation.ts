import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import register from '../index.js';
import { toyTranscript } from '../fixtures/toy-transcript.js';
import { routeMemoryCandidate, resolveMemoryRelativePath } from './memory/router.js';
import { LayeredMemoryWorkspaceStore } from './memory/workspace-store.js';

type RuntimeEngine = {
  ingestBatch: (params: {
    sessionId: string;
    sessionKey?: string;
    messages: Array<Record<string, unknown>>;
  }) => Promise<unknown>;
  assemble: (params: {
    sessionId: string;
    sessionKey?: string;
    messages: Array<Record<string, unknown>>;
    tokenBudget?: number;
  }) => Promise<{
    messages?: Array<Record<string, unknown>>;
    systemPromptAddition?: string;
  }>;
  compact: (params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    currentTokenCount?: number;
  }) => Promise<unknown>;
  afterTurn: (params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    messages: Array<Record<string, unknown>>;
    prePromptMessageCount: number;
  }) => Promise<void>;
};

function createRuntimeFactory(): (runtimeConfig?: unknown) => Promise<RuntimeEngine> {
  const registrations: Array<{ id: string; factory: (runtimeConfig?: unknown) => unknown | Promise<unknown> }> = [];

  register({
    registerContextEngine(id, factory) {
      registrations.push({ id, factory });
    },
  });

  if (!registrations[0]) {
    throw new Error('hypergraph-context-engine was not registered');
  }

  return async (runtimeConfig?: unknown) => registrations[0]!.factory(runtimeConfig) as Promise<RuntimeEngine>;
}

function createHookBridgeHarness(pluginConfig?: Record<string, unknown>) {
  const hooks = new Map<string, (...args: unknown[]) => unknown>();

  register({
    pluginConfig,
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

  return hooks;
}

function toRuntimeMessages(): Array<Record<string, unknown>> {
  return toyTranscript.map((entry) => ({
    ...entry,
    role: entry.role ?? entry.type,
  }));
}

async function main() {
  const createEngine = createRuntimeFactory();
  const results = [];

  {
    const tempDir = mkdtempSync(join(tmpdir(), 'openclaw-runtime-hook-bridge-'));
    const hooks = createHookBridgeHarness({
      disablePersistence: true,
      memoryWorkspaceRoot: tempDir,
      flushOnAfterTurn: true,
      flushOnCompact: true,
      promoteOnMaintenance: false,
    });
    const beforeAgentStart = hooks.get('before_agent_start');
    const agentEnd = hooks.get('agent_end');
    const beforeCompaction = hooks.get('before_compaction');
    const hookResult = await beforeAgentStart?.(
      {
        prompt: 'continue fixing runtime lifecycle',
        messages: toRuntimeMessages(),
      },
      {
        sessionKey: 'hook-bridge-chat',
        agentId: 'hook-agent',
      },
    ) as { prependContext?: string } | undefined;

    await agentEnd?.(
      {
        success: true,
        messages: toRuntimeMessages(),
      },
      {
        sessionKey: 'hook-bridge-chat',
        agentId: 'hook-agent',
      },
    );

    await beforeCompaction?.(
      {
        messageCount: toyTranscript.length,
        tokenCount: 512,
      },
      {
        sessionKey: 'hook-bridge-chat',
        agentId: 'hook-agent',
      },
    );

    results.push({
      scenario: 'hook-bridge-fallback',
      hooksRegistered: hooks.size,
      prependedContext: /\[Hypergraph Context Bridge\]/.test(hookResult?.prependContext ?? ''),
      hasIntent: /Intent:/.test(hookResult?.prependContext ?? ''),
      nowExists: existsSync(join(tempDir, 'NOW.md')),
    });
  }

  {
    const engine = await createEngine({ disablePersistence: true });
    const assembled = await engine.assemble({
      sessionId: 'bootstrap-turn',
      sessionKey: 'bootstrap-chat',
      messages: toRuntimeMessages(),
      tokenBudget: 400,
    });

    results.push({
      scenario: 'assemble-bootstrap',
      messageCount: assembled.messages?.length ?? 0,
      hasIntent: /Intent:/.test(assembled.systemPromptAddition ?? ''),
      usedEmptyFallback: /no session snapshot yet/i.test(assembled.systemPromptAddition ?? ''),
    });
  }

  {
    const tempDir = mkdtempSync(join(tmpdir(), 'openclaw-runtime-flush-on-'));
    const engine = await createEngine({
      disablePersistence: true,
      memoryWorkspaceRoot: tempDir,
      flushOnAfterTurn: true,
      enableLayeredRead: true,
      enableLayeredWrite: true,
      promoteOnMaintenance: false,
    });
    await engine.afterTurn({
      sessionId: 'flush-turn',
      sessionKey: 'flush-chat',
      sessionFile: 'session.jsonl',
      messages: toRuntimeMessages(),
      prePromptMessageCount: 0,
    });

    results.push({
      scenario: 'afterturn-flush-enabled',
      nowExists: existsSync(join(tempDir, 'NOW.md')),
      hotFiles: existsSync(join(tempDir, 'memory', 'hot'))
        ? readdirSync(join(tempDir, 'memory', 'hot')).length
        : 0,
    });
  }

  {
    const tempDir = mkdtempSync(join(tmpdir(), 'openclaw-runtime-flush-off-'));
    const engine = await createEngine({
      disablePersistence: true,
      memoryWorkspaceRoot: tempDir,
      flushOnAfterTurn: false,
      enableLayeredRead: true,
      enableLayeredWrite: true,
      promoteOnMaintenance: false,
    });
    await engine.afterTurn({
      sessionId: 'flush-off-turn',
      sessionKey: 'flush-off-chat',
      sessionFile: 'session.jsonl',
      messages: toRuntimeMessages(),
      prePromptMessageCount: 0,
    });

    results.push({
      scenario: 'afterturn-flush-disabled',
      nowExists: existsSync(join(tempDir, 'NOW.md')),
    });
  }

  {
    const tempDir = mkdtempSync(join(tmpdir(), 'openclaw-runtime-persist-'));
    const dbPath = join(tempDir, 'runtime.sqlite');
    const first = await createEngine({
      dbPath,
      memoryWorkspaceRoot: join(tempDir, 'memory'),
      disablePersistence: false,
      flushOnAfterTurn: false,
      flushOnCompact: false,
    });
    await first.ingestBatch({
      sessionId: 'persist-turn-1',
      sessionKey: 'persist-chat',
      messages: toRuntimeMessages(),
    });
    const second = await createEngine({
      dbPath,
      memoryWorkspaceRoot: join(tempDir, 'memory'),
      disablePersistence: false,
      flushOnAfterTurn: false,
      flushOnCompact: false,
    });
    const assembled = await second.assemble({
      sessionId: 'persist-turn-2',
      sessionKey: 'persist-chat',
      messages: [],
      tokenBudget: 400,
    });

    results.push({
      scenario: 'persistence-resume',
      dbExists: existsSync(dbPath),
      messageCount: assembled.messages?.length ?? 0,
      hasIntent: /Intent:/.test(assembled.systemPromptAddition ?? ''),
    });
  }

  {
    const tempDir = mkdtempSync(join(tmpdir(), 'openclaw-runtime-maintain-'));
    const store = new LayeredMemoryWorkspaceStore(tempDir);
    const now = '2026-03-23T10:00:00.000Z';
    const candidate = routeMemoryCandidate({
      title: 'Current Task State',
      summary: 'Stabilize afterTurn maintenance',
      category: 'current-task',
      scope: 'task',
      persistence: 'task',
      recurrence: 3,
      connectivity: 3,
      activationEnergy: 'low',
    });

    store.writeFlush({
      nowState: {
        currentTask: 'afterTurn maintenance',
        currentPlan: [],
        blockers: [],
        nextSteps: [],
        updatedAt: now,
      },
      entries: [{
        ...candidate,
        updatedAt: now,
        firstSeenAt: '2026-03-20T10:00:00.000Z',
        hitCount: 3,
        sessionCount: 2,
        lastSessionId: 'persist-chat',
        sourceFile: '',
      }],
      dailyAudit: ['seed hot entry'],
    });

    const engine = await createEngine({
      disablePersistence: true,
      memoryWorkspaceRoot: tempDir,
      enableLayeredRead: true,
      enableLayeredWrite: false,
      flushOnAfterTurn: false,
      promoteOnMaintenance: true,
    });
    await engine.afterTurn({
      sessionId: 'maintain-turn',
      sessionKey: 'maintain-chat',
      sessionFile: 'session.jsonl',
      messages: [],
      prePromptMessageCount: 0,
    });

    results.push({
      scenario: 'maintenance-promotion',
      hotExists: existsSync(join(tempDir, 'memory', 'hot', 'current-task.md')),
      warmExists: existsSync(join(tempDir, resolveMemoryRelativePath({
        layer: 'warm',
        category: 'current-task',
        dedupeKey: candidate.dedupeKey,
      }))),
    });
  }

  {
    const engine = await createEngine({ disablePersistence: true });
    await engine.ingestBatch({
      sessionId: 'compact-turn-1',
      sessionKey: 'compact-chat',
      messages: toRuntimeMessages(),
    });
    const compacted = await engine.compact({
      sessionId: 'compact-turn-1',
      sessionKey: 'compact-chat',
      sessionFile: 'session.jsonl',
      currentTokenCount: 999,
    }) as {
      ok: boolean;
      compacted: boolean;
      result?: {
        firstKeptEntryId?: string;
        tokensBefore?: number;
        tokensAfter?: number;
      };
    };

    results.push({
      scenario: 'compact-contract',
      ok: compacted.ok,
      compacted: compacted.compacted,
      firstKeptEntryId: compacted.result?.firstKeptEntryId ?? null,
      tokensBefore: compacted.result?.tokensBefore ?? null,
      tokensAfter: compacted.result?.tokensAfter ?? null,
    });
  }

  console.log(JSON.stringify(results, null, 2));
}

await main();
