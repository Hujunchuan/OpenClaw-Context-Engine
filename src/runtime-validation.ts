import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import register from '../index.js';
import { toyTranscript } from '../fixtures/toy-transcript.js';
import { retrieveRelevantNodes } from './core/retriever.js';
import { materializeTaskState } from './core/task-state.js';
import { routeMemoryCandidate, resolveMemoryRelativePath } from './memory/router.js';
import { LayeredMemoryWorkspaceStore } from './memory/workspace-store.js';
import { detectSlotSafeRuntimeProfile } from './plugin/runtime-message-utils.js';
import { WorkspaceMemoryRepository } from './memory/repository.js';

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
    runtimeContext?: Record<string, unknown>;
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
      runtimeIdentityDebug: true,
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
        workspaceDir: '/workspace/hook-bridge',
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
        workspaceDir: '/workspace/hook-bridge',
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
        workspaceDir: '/workspace/hook-bridge',
      },
    );
    const hookIdentityLog = readFileSync(join(tempDir, 'runtime-identity-debug.log'), 'utf8');

    results.push({
      scenario: 'hook-bridge-fallback',
      hooksRegistered: hooks.size,
      prependedContext: /\[Hypergraph Context Bridge\]/.test(hookResult?.prependContext ?? ''),
      hasIntent: /Intent:/.test(hookResult?.prependContext ?? ''),
      nowExists: existsSync(join(tempDir, 'NOW.md')),
      identityLogged: /"sessionId":"hook-bridge-chat"/.test(hookIdentityLog),
      workspaceLogged: /"workspaceId":"\/workspace\/hook-bridge"/.test(hookIdentityLog),
    });
  }

  {
    results.push({
      scenario: 'slot-safe-profiles',
      plainDialogue: detectSlotSafeRuntimeProfile([
        {
          id: 'u1',
          role: 'user',
          content: 'Hello',
          createdAt: '2026-03-23T08:00:00.000Z',
        },
        {
          id: 'a1',
          role: 'assistant',
          content: 'Hi there',
          createdAt: '2026-03-23T08:01:00.000Z',
        },
      ]).name,
      toolTurns: detectSlotSafeRuntimeProfile([
        {
          id: 'u1',
          role: 'user',
          content: 'Run the tool',
          createdAt: '2026-03-23T08:00:00.000Z',
        },
        {
          id: 'tool-1',
          role: 'tool',
          type: 'tool_result',
          content: 'Tool output',
          createdAt: '2026-03-23T08:01:00.000Z',
        },
      ]).name,
      structuredAssistant: detectSlotSafeRuntimeProfile([
        {
          id: 'a1',
          role: 'assistant',
          content: [
            { type: 'thinking', thinkingSignature: 'sig' },
            { type: 'output_text', text: 'Structured reply' },
          ],
          createdAt: '2026-03-23T08:01:00.000Z',
        },
      ]).name,
    });
  }

  {
    const namespacedNodes = [
      createNamespacedMemoryNode(
        'memory/warm/session-memory.md',
        'warm',
        'Session task memory',
        'Current task is stabilizing slot-safe retrieval.',
        {
          lastSessionId: 'current-session',
          lastAgentId: 'agent-blue',
          lastWorkspaceId: '/workspace/blue',
        },
      ),
      createNamespacedMemoryNode(
        'memory/warm/agent-memory.md',
        'warm',
        'Agent task memory',
        'Current task is stabilizing slot-safe retrieval.',
        {
          lastSessionId: 'other-session',
          lastAgentId: 'agent-blue',
          lastWorkspaceId: '/workspace/other',
        },
      ),
      createNamespacedMemoryNode(
        'memory/warm/workspace-memory.md',
        'warm',
        'Workspace task memory',
        'Current task is stabilizing slot-safe retrieval.',
        {
          lastSessionId: 'other-session',
          lastAgentId: 'agent-other',
          lastWorkspaceId: '/workspace/blue',
        },
      ),
      createNamespacedMemoryNode(
        'memory/cold/global-memory.md',
        'cold',
        'Global task memory',
        'Current task is stabilizing slot-safe retrieval.',
        {
          lastSessionId: 'other-session',
          lastAgentId: 'agent-other',
          lastWorkspaceId: '/workspace/other',
        },
      ),
    ];
    const taskState = materializeTaskState('current-session', namespacedNodes, []);
    const retrieved = retrieveRelevantNodes({
      nodes: namespacedNodes,
      taskState,
      currentTurnText: 'What is the current task and next step?',
      limit: 4,
      memoryNamespace: {
        sessionId: 'current-session',
        agentId: 'agent-blue',
        workspaceId: '/workspace/blue',
      },
    });

    results.push({
      scenario: 'namespace-memory-priority',
      selectedNodeIds: retrieved.selectedNodeIds,
      expectedOrder: [
        'memory:memory/warm/session-memory.md',
        'memory:memory/warm/agent-memory.md',
        'memory:memory/warm/workspace-memory.md',
        'memory:memory/cold/global-memory.md',
      ],
      sessionFirst: retrieved.selectedNodeIds[0] === 'memory:memory/warm/session-memory.md',
      agentSecond: retrieved.selectedNodeIds[1] === 'memory:memory/warm/agent-memory.md',
      workspaceThird: retrieved.selectedNodeIds[2] === 'memory:memory/warm/workspace-memory.md',
      globalLast: retrieved.selectedNodeIds[3] === 'memory:memory/cold/global-memory.md',
    });
  }

  {
    const tempDir = mkdtempSync(join(tmpdir(), 'openclaw-runtime-explicit-session-'));
    const engine = await createEngine({
      disablePersistence: true,
      memoryWorkspaceRoot: tempDir,
      enableLayeredRead: true,
      enableLayeredWrite: true,
      flushOnAfterTurn: true,
      promoteOnMaintenance: false,
    });
    await engine.afterTurn({
      sessionId: 'explicit-session-id',
      sessionKey: 'agent:main:main',
      sessionFile: '/tmp/explicit-session.jsonl',
      messages: [
        {
          id: 'u1',
          role: 'user',
          content: 'Current task: verify explicit session id wins over generic agent session key.',
          createdAt: '2026-03-24T10:00:00.000Z',
        },
      ],
      prePromptMessageCount: 0,
    });
    const nowText = readFileSync(join(tempDir, 'NOW.md'), 'utf8');

    results.push({
      scenario: 'explicit-session-id-priority',
      explicitSessionPersisted: /last_session_id: explicit-session-id/.test(nowText),
    });
  }

  {
    const tempDir = mkdtempSync(join(tmpdir(), 'openclaw-runtime-identity-debug-'));
    const engine = await createEngine({
      disablePersistence: true,
      memoryWorkspaceRoot: tempDir,
      runtimeIdentityDebug: true,
      flushOnAfterTurn: true,
    });
    await engine.afterTurn({
      sessionId: 'explicit-debug-session',
      sessionKey: 'agent:main:main',
      sessionFile: '/tmp/explicit-debug-session.jsonl',
      runtimeContext: {
        workspaceDir: '/workspace/debug-session',
      },
      messages: [
        {
          id: 'u-debug-1',
          role: 'user',
          content: 'Current task: confirm runtime identity debug logging.',
          createdAt: '2026-03-24T10:05:00.000Z',
        },
      ],
      prePromptMessageCount: 0,
    });
    const debugLog = readFileSync(join(tempDir, 'runtime-identity-debug.log'), 'utf8');

    results.push({
      scenario: 'runtime-identity-debug',
      explicitSessionLogged: /"sessionId":"explicit-debug-session"/.test(debugLog),
      explicitSessionSource: /"sources":\{"sessionId":"sessionId"/.test(debugLog),
      workspaceLogged: /"workspaceId":"\/workspace\/debug-session"/.test(debugLog),
    });
  }

  {
    const tempDir = mkdtempSync(join(tmpdir(), 'openclaw-runtime-session-alias-'));
    const engine = await createEngine({
      disablePersistence: true,
      memoryWorkspaceRoot: tempDir,
      runtimeIdentityDebug: true,
      flushOnAfterTurn: true,
      enableLayeredRead: true,
      enableLayeredWrite: true,
      promoteOnMaintenance: false,
    });
    const userMessage = {
      id: 'u-alias-1',
      role: 'user',
      content: 'Current task: alpha session isolation test. Next step: verify alpha isolation.',
      createdAt: '2026-03-24T11:10:00.000Z',
    };
    await engine.assemble({
      sessionId: 'slot-alias-alpha',
      sessionKey: 'agent:main:main',
      messages: [userMessage],
      tokenBudget: 320,
    });
    await engine.afterTurn({
      sessionId: '72951471-da2c-42c9-8976-459d52f5ad92',
      sessionKey: 'agent:main:main',
      sessionFile: '/tmp/agents/main/sessions/72951471-da2c-42c9-8976-459d52f5ad92.jsonl',
      runtimeContext: {
        workspaceDir: '/workspace/alias-alpha',
      },
      messages: [
        userMessage,
        {
          id: 'a-alias-1',
          role: 'assistant',
          content: 'Stored alpha task and next step.',
          createdAt: '2026-03-24T11:10:05.000Z',
        },
      ],
      prePromptMessageCount: 0,
    });
    const nowText = readFileSync(join(tempDir, 'NOW.md'), 'utf8');
    const aliasDebugLog = readFileSync(join(tempDir, 'runtime-identity-debug.log'), 'utf8');

    results.push({
      scenario: 'session-alias-afterturn',
      explicitSessionPersisted: /last_session_id: slot-alias-alpha/.test(nowText),
      aliasSourceUsed: /"lifecycle":"afterTurn".*"sessionId":"slot-alias-alpha".*"alias.messageFingerprint"/s.test(aliasDebugLog),
    });
  }

  {
    const tempDir = mkdtempSync(join(tmpdir(), 'openclaw-runtime-query-gate-'));
    const store = new LayeredMemoryWorkspaceStore(tempDir);
    const repository = new WorkspaceMemoryRepository(tempDir);
    const now = '2026-03-24T11:00:00.000Z';

    store.writeFlush({
      nowState: {
        currentTask: 'Session alpha task',
        currentPlan: [],
        blockers: [],
        nextSteps: [],
        updatedAt: now,
        lastSessionId: 'session-alpha',
        lastAgentId: 'agent-alpha',
        lastWorkspaceId: '/workspace/shared',
      },
      entries: [
        {
          ...routeMemoryCandidate({
            title: 'Current Task State',
            summary: 'Session alpha task',
            category: 'current-task',
            scope: 'task',
            persistence: 'task',
            recurrence: 1,
            connectivity: 2,
            activationEnergy: 'low',
          }),
          updatedAt: now,
          firstSeenAt: now,
          hitCount: 1,
          sessionCount: 1,
          lastSessionId: 'session-alpha',
          lastAgentId: 'agent-alpha',
          lastWorkspaceId: '/workspace/shared',
          sourceFile: '',
        },
        {
          ...routeMemoryCandidate({
            title: 'Global Principle',
            summary: 'Transcript stays the source of truth.',
            category: 'system-principles',
            scope: 'system',
            persistence: 'long_term',
            recurrence: 4,
            connectivity: 4,
            activationEnergy: 'high',
          }),
          updatedAt: now,
          firstSeenAt: '2026-03-01T11:00:00.000Z',
          hitCount: 4,
          sessionCount: 3,
          lastSessionId: 'other-session',
          lastAgentId: 'agent-other',
          lastWorkspaceId: '/workspace/other',
          sourceFile: '',
        },
      ],
      dailyAudit: ['seed query-gate memory'],
    });

    const sessionHotOnly = repository.read({
      sessionId: 'session-alpha',
      agentId: 'agent-alpha',
      workspaceId: '/workspace/shared',
      queryGateMode: 'session_hot_only',
    });
    const transcriptOnly = repository.read({
      sessionId: 'session-alpha',
      agentId: 'agent-alpha',
      workspaceId: '/workspace/shared',
      queryGateMode: 'transcript_only',
    });

    results.push({
      scenario: 'query-gate-read-modes',
      sessionHotOnlyLayers: sessionHotOnly.entries.map((entry) => entry.layer),
      sessionHotOnlySessionIds: sessionHotOnly.entries.map((entry) => entry.lastSessionId),
      transcriptOnlyCount: transcriptOnly.entries.length,
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
    const engine = await createEngine({ disablePersistence: true });
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
    const assembled = await engine.assemble({
      sessionId: 'prev-message-turn',
      sessionKey: 'prev-message-chat',
      messages: [t1, t2, t3],
      tokenBudget: 420,
    });

    results.push({
      scenario: 'slot-safe-previous-message',
      profile: detectSlotSafeRuntimeProfile([t1, t2, t3]).name,
      previousIncluded: assembled.messages?.some((message) => message.id === 'u2') ?? false,
      firstIncluded: assembled.messages?.some((message) => message.id === 'u1') ?? false,
      syntheticSourceInjected: assembled.messages?.some((message) => message.source === 'hypergraph-context-engine') ?? false,
      hasPreviousHint: /Immediate previous user message:/i.test(assembled.systemPromptAddition ?? ''),
    });
  }

  {
    const engine = await createEngine({ disablePersistence: true });
    const currentTaskMessages = [
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
        content: 'I will keep the slot-safe policy strict and use systemPromptAddition for semantic recall.',
        createdAt: '2026-03-23T09:02:00.000Z',
      },
      {
        id: 'u3',
        role: 'user',
        content: 'What is the current task and next step?',
        createdAt: '2026-03-23T09:03:00.000Z',
      },
    ];
    const assembled = await engine.assemble({
      sessionId: 'current-task-turn',
      sessionKey: 'current-task-chat',
      messages: currentTaskMessages,
      tokenBudget: 420,
    });

    results.push({
      scenario: 'slot-safe-current-task',
      profile: detectSlotSafeRuntimeProfile(currentTaskMessages).name,
      taskDefinitionIncluded: assembled.messages?.some((message) => message.id === 'u1') ?? false,
      userNextStepIncluded: assembled.messages?.some((message) => message.id === 'u2') ?? false,
      assistantCommitmentIncluded: assembled.messages?.some((message) => message.id === 'a1') ?? false,
      hasTaskDefinitionHint: /Latest task-defining user message:/i.test(assembled.systemPromptAddition ?? ''),
      hasUserNextStepHint: /Latest user-defined next step:/i.test(assembled.systemPromptAddition ?? ''),
      hasCanonicalTaskHint: /Canonical current session task:/i.test(assembled.systemPromptAddition ?? ''),
      hasCanonicalNextStepHint: /Canonical current session next step:/i.test(assembled.systemPromptAddition ?? ''),
      hasAssistantCommitmentHint: /Latest assistant commitment:/i.test(assembled.systemPromptAddition ?? ''),
    });
  }

  {
    const tempDir = mkdtempSync(join(tmpdir(), 'openclaw-runtime-current-now-'));
    const engine = await createEngine({
      disablePersistence: true,
      memoryWorkspaceRoot: tempDir,
      enableLayeredRead: true,
      enableLayeredWrite: true,
      flushOnAfterTurn: true,
      promoteOnMaintenance: false,
    });
    const currentTaskMessages = [
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
        content: '**Current task:** Stabilize slot-safe context assembly for long conversations (already completed, verification in progress).\n\n**Next step:** Run live runtime tests to confirm recall path still prefers real task definition over recall question.',
        createdAt: '2026-03-23T09:01:30.000Z',
      },
      {
        id: 'a2',
        role: 'assistant',
        content: 'Next step: 0013053899999999998',
        createdAt: '2026-03-23T09:01:40.000Z',
      },
      {
        id: 'a3',
        role: 'assistant',
        content: 'Next step: agent:main:slot-ns-beta-20260324f',
        createdAt: '2026-03-23T09:01:50.000Z',
      },
      {
        id: 'u3',
        role: 'user',
        content: 'What is the current task and next step? Answer in two short lines.',
        createdAt: '2026-03-23T09:02:00.000Z',
      },
    ];

    await engine.afterTurn({
      sessionId: 'current-task-now-turn',
      sessionKey: 'current-task-now-chat',
      sessionFile: 'session.jsonl',
      messages: currentTaskMessages,
      prePromptMessageCount: 0,
    });

    const nowPath = join(tempDir, 'NOW.md');
    const nowText = existsSync(nowPath) ? readFileSync(nowPath, 'utf8') : '';

    results.push({
      scenario: 'now-current-task-persistence',
      nowExists: existsSync(nowPath),
      currentTaskPreserved: /stabilize slot-safe context assembly for long conversations/i.test(nowText),
      nextStepPreserved: /verify the current-task recall path still prefers the real task definition/i.test(nowText),
      recallQuestionSuppressed: !/What is the current task and next step\?/i.test(nowText),
      planSanitized: !/<final>|Current task:\*\*|\*\*/i.test(nowText),
      nextStepsDeduplicated: (nowText.match(/verify the current-task recall path still prefers the real task definition/gi) ?? []).length === 1,
      nextStepNoiseSuppressed: !/0013053899999999998|agent:main:slot-ns-beta-20260324f/i.test(nowText),
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

function createNamespacedMemoryNode(
  relativePath: string,
  layer: 'hot' | 'warm' | 'cold' | 'daily_log' | 'memory_core' | 'archive',
  title: string,
  summary: string,
  namespace: {
    lastSessionId?: string;
    lastAgentId?: string;
    lastWorkspaceId?: string;
  },
) {
  return {
    id: `memory:${relativePath}`,
    kind: 'memory_chunk' as const,
    sessionId: 'runtime-validation-session',
    createdAt: '2026-03-24T00:00:00.000Z',
    tags: ['memory', layer],
    payload: {
      layer,
      scope: layer === 'cold' ? 'system' : 'workflow',
      sourceFile: relativePath,
      title,
      summary,
      text: summary,
      dedupeKey: relativePath.replace(/[/.]+/g, '-'),
      persistence: layer === 'cold' ? 'long_term' : 'project',
      recurrence: layer === 'hot' ? 1 : 3,
      connectivity: layer === 'hot' ? 2 : 4,
      activationEnergy: layer === 'hot' ? 'low' : layer === 'warm' ? 'medium' : 'high',
      status: 'active',
      updatedAt: '2026-03-24T00:00:00.000Z',
      ...namespace,
    },
  };
}
