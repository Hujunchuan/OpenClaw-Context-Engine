import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { BaseNode, MemoryChunkPayload } from '../../schemas/types.js';
import { toySessionId, toyTranscript } from '../../fixtures/toy-transcript.js';
import { HypergraphContextEngine } from '../../src/core/engine.js';
import { retrieveRelevantNodes } from '../../src/core/retriever.js';
import { materializeTaskState } from '../../src/core/task-state.js';
import { indexLayeredMemoryEntries } from '../../src/memory/indexer.js';
import { WorkspaceMemoryRepository } from '../../src/memory/repository.js';
import {
  resolveMemoryCoreRelativePath,
  resolveMemoryRelativePath,
  resolveNowRelativePath,
  routeLayeredMemory,
  routeMemoryCandidate,
} from '../../src/memory/router.js';
import { LayeredMemoryWorkspaceStore } from '../../src/memory/workspace-store.js';

test('routeMemoryCandidate classifies state, reusable patterns, and long-term facts by layer', () => {
  const hot = routeMemoryCandidate({
    title: 'Current Task State',
    summary: 'Finish the current task state and next blockers.',
    scope: 'task',
    persistence: 'task',
    recurrence: 1,
    connectivity: 3,
    activationEnergy: 'low',
  });
  const warm = routeMemoryCandidate({
    title: 'Reusable Pattern',
    summary: 'This workflow is a reusable pattern that should be applied repeatedly.',
    scope: 'workflow',
    persistence: 'project',
    recurrence: 3,
    connectivity: 4,
    activationEnergy: 'medium',
  });
  const cold = routeMemoryCandidate({
    title: 'Long-Term Principle',
    summary: 'Transcript remains the source of truth and should always stay canonical.',
    scope: 'system',
    persistence: 'long_term',
    recurrence: 2,
    connectivity: 3,
    activationEnergy: 'high',
  });

  assert.equal(hot.layer, 'hot');
  assert.equal(warm.layer, 'warm');
  assert.equal(cold.layer, 'cold');
  assert.ok(hot.abstract.length > 0);
  assert.ok(hot.overview.length >= hot.abstract.length);
  assert.ok((hot.detail ?? '').includes(hot.summary));
});

test('workspace store writes layered markdown files and can re-index them', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'layered-memory-store-'));
  const store = new LayeredMemoryWorkspaceStore(tempDir);
  const now = '2026-03-22T16:00:00.000Z';
  const flushPlan = {
    nowState: {
      currentTask: 'Implement layered memory persistence',
      currentPlan: ['Wire engine flushMemory', 'Hydrate memory into assemble'],
      blockers: ['Need regression coverage'],
      nextSteps: ['Add layer-aware retrieval tests'],
      updatedAt: now,
    },
    entries: [
      {
        ...routeMemoryCandidate({
          title: 'Current Task State',
          summary: 'Implement layered memory persistence',
          details: ['Active decision: Wire engine flushMemory'],
          category: 'current-task',
          scope: 'task',
          persistence: 'task',
          recurrence: 1,
          connectivity: 3,
          activationEnergy: 'low',
        }),
        updatedAt: now,
        firstSeenAt: now,
        hitCount: 1,
        sessionCount: 1,
        lastSessionId: toySessionId,
        lastAgentId: 'agent-layered-memory',
        lastWorkspaceId: 'workspace-layered-memory',
        sourceFile: '',
        relativePath: 'memory/hot/current-task.md',
      },
      {
        ...routeMemoryCandidate({
          title: 'Reusable Pattern',
          summary: 'Use a reusable pattern for flush plus hydrate memory workflows.',
          details: ['Pattern: flush before compact'],
          category: 'pattern',
          scope: 'workflow',
          persistence: 'project',
          recurrence: 3,
          connectivity: 4,
          activationEnergy: 'medium',
        }),
        updatedAt: now,
        firstSeenAt: '2026-03-10T16:00:00.000Z',
        hitCount: 3,
        sessionCount: 2,
        lastSessionId: toySessionId,
        lastAgentId: 'agent-layered-memory',
        lastWorkspaceId: 'workspace-layered-memory',
        sourceFile: '',
        relativePath: 'memory/warm/pattern.md',
      },
      {
        ...routeMemoryCandidate({
          title: 'Long-Term Principle',
          summary: 'Transcript remains the source of truth for long-term system behavior.',
          details: ['Principle: source of truth'],
          category: 'system-principles',
          scope: 'system',
          persistence: 'long_term',
          recurrence: 4,
          connectivity: 4,
          activationEnergy: 'high',
        }),
        updatedAt: now,
        firstSeenAt: '2026-03-01T16:00:00.000Z',
        hitCount: 4,
        sessionCount: 3,
        lastSessionId: toySessionId,
        lastAgentId: 'agent-layered-memory',
        lastWorkspaceId: 'workspace-layered-memory',
        sourceFile: '',
        relativePath: 'memory/cold/system-principles.md',
      },
    ],
    dailyAudit: ['Flush reason: manual_save', 'Wrote layered entries: hot, warm, cold'],
  };

  const result = store.writeFlush(flushPlan);
  const entries = store.readEntries();
  const indexed = indexLayeredMemoryEntries(toySessionId, entries);
  const nowRelativePath = resolveNowRelativePath({
    sessionId: toySessionId,
    agentId: 'agent-layered-memory',
    workspaceId: 'workspace-layered-memory',
  });

  assert.ok(result.writtenFiles.includes(nowRelativePath));
  assert.ok(result.writtenFiles.some((file) => file.startsWith('.hypergraph-memory/session/')));
  assert.ok(result.writtenFiles.some((file) => file.includes('/warm--')));
  assert.ok(result.writtenFiles.some((file) => file.includes('/cold--')));
  assert.ok(existsSync(join(tempDir, resolveMemoryCoreRelativePath())));
  assert.ok(indexed.some((node) => (node.payload as MemoryChunkPayload).layer === 'hot'));
  assert.ok(indexed.some((node) => (node.payload as MemoryChunkPayload).layer === 'warm'));
  assert.ok(indexed.some((node) => (node.payload as MemoryChunkPayload).layer === 'cold'));
  assert.ok(indexed.some((node) => (node.payload as MemoryChunkPayload).lastAgentId === 'agent-layered-memory'));
  assert.ok(indexed.some((node) => (node.payload as MemoryChunkPayload).lastWorkspaceId === 'workspace-layered-memory'));
  assert.match(readFileSync(join(tempDir, resolveMemoryCoreRelativePath()), 'utf8'), /Curated Long-Term Memory/);
});

test('workspace store persists memory namespace metadata into markdown frontmatter', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'layered-memory-namespace-store-'));
  const store = new LayeredMemoryWorkspaceStore(tempDir);
  const now = '2026-03-24T08:00:00.000Z';

  store.writeFlush({
    nowState: {
      currentTask: 'Isolate memory writes by namespace',
      currentPlan: [],
      blockers: [],
      nextSteps: [],
      updatedAt: now,
      lastSessionId: 'session-alpha',
      lastAgentId: 'agent-alpha',
      lastWorkspaceId: '/workspace/alpha',
    },
    entries: [{
      ...routeMemoryCandidate({
        title: 'Current Task State',
        summary: 'Isolate memory writes by session agent and workspace.',
        category: 'current-task',
        scope: 'task',
        persistence: 'task',
        recurrence: 1,
        connectivity: 3,
        activationEnergy: 'low',
      }),
      updatedAt: now,
      firstSeenAt: now,
      hitCount: 1,
      sessionCount: 1,
      lastSessionId: 'session-alpha',
      lastAgentId: 'agent-alpha',
      lastWorkspaceId: '/workspace/alpha',
      sourceFile: '',
      relativePath: 'memory/hot/current-task.md',
    }],
    dailyAudit: ['seed namespaced hot entry'],
  });

  const nowFile = readFileSync(join(tempDir, resolveNowRelativePath({
    sessionId: 'session-alpha',
    agentId: 'agent-alpha',
    workspaceId: '/workspace/alpha',
  })), 'utf8');
  const entries = store.readEntries();
  const hotEntry = entries.find((entry) => entry.layer === 'hot' && entry.lastSessionId === 'session-alpha');
  assert.ok(hotEntry);
  const hotFile = readFileSync(join(tempDir, hotEntry!.relativePath), 'utf8');

  assert.match(hotFile, /last_session_id: session-alpha/);
  assert.match(hotFile, /last_agent_id: agent-alpha/);
  assert.match(hotFile, /last_workspace_id: \/workspace\/alpha/);
  assert.match(nowFile, /last_session_id: session-alpha/);
  assert.match(nowFile, /last_agent_id: agent-alpha/);
  assert.match(nowFile, /last_workspace_id: \/workspace\/alpha/);
  assert.ok(entries.some((entry) => entry.lastAgentId === 'agent-alpha' && entry.lastWorkspaceId === '/workspace/alpha'));
});

test('hot memory writes stay isolated across sessions and agents', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'layered-memory-hot-isolation-'));
  const repository = new WorkspaceMemoryRepository(tempDir);
  const now = '2026-03-24T09:00:00.000Z';
  const baseTaskState = materializeTaskState('session-alpha', [], []);

  repository.flush({
    sessionId: 'session-alpha',
    agentId: 'agent-alpha',
    workspaceId: '/workspace/shared',
    reason: 'manual_save',
    nodes: [],
    taskState: {
      ...baseTaskState,
      sessionId: 'session-alpha',
      intent: 'Current task: stabilize session alpha hot memory.',
      activeDecisions: ['Stabilize session alpha hot memory.'],
      lastUpdatedAt: now,
    },
  });

  repository.flush({
    sessionId: 'session-beta',
    agentId: 'agent-beta',
    workspaceId: '/workspace/shared',
    reason: 'manual_save',
    nodes: [],
    taskState: {
      ...baseTaskState,
      sessionId: 'session-beta',
      intent: 'Current task: stabilize session beta hot memory.',
      activeDecisions: ['Stabilize session beta hot memory.'],
      lastUpdatedAt: now,
    },
  });

  const entries = repository.read({
    sessionId: 'session-beta',
    agentId: 'agent-beta',
    workspaceId: '/workspace/shared',
  }).entries;
  const hotEntries = entries.filter((entry) => entry.layer === 'hot' && entry.category === 'current-task');

  assert.ok(hotEntries.some((entry) => entry.lastSessionId === 'session-alpha' && entry.lastAgentId === 'agent-alpha'));
  assert.ok(hotEntries.some((entry) => entry.lastSessionId === 'session-beta' && entry.lastAgentId === 'agent-beta'));
  assert.equal(new Set(hotEntries.map((entry) => entry.relativePath)).size >= 2, true);
});

test('workspace store removes stale files when a memory entry moves across layers', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'layered-memory-move-'));
  const store = new LayeredMemoryWorkspaceStore(tempDir);
  const first = routeMemoryCandidate({
    title: 'Reusable Pattern',
    summary: 'Use a reusable workflow for flush and hydrate memory.',
    category: 'pattern',
    scope: 'workflow',
    persistence: 'project',
    recurrence: 3,
    connectivity: 3,
    activationEnergy: 'medium',
  });
  const second = {
    ...first,
    layer: 'cold' as const,
    category: 'system-principles',
    relativePath: '',
    updatedAt: '2026-03-22T18:00:00.000Z',
    firstSeenAt: '2026-03-01T18:00:00.000Z',
    hitCount: 4,
    sessionCount: 3,
    lastSessionId: toySessionId,
    sourceFile: '',
  };

  store.writeFlush({
    nowState: {
      currentTask: 'seed warm memory',
      currentPlan: [],
      blockers: [],
      nextSteps: [],
      updatedAt: '2026-03-22T17:00:00.000Z',
    },
    entries: [{
      ...first,
      updatedAt: '2026-03-22T17:00:00.000Z',
      firstSeenAt: '2026-03-20T17:00:00.000Z',
      hitCount: 3,
      sessionCount: 2,
      lastSessionId: toySessionId,
      sourceFile: '',
    }],
    dailyAudit: ['seed warm entry'],
  });

  const warmPath = join(tempDir, first.relativePath);
  assert.ok(existsSync(warmPath));

  store.writeFlush({
    nowState: {
      currentTask: 'promote memory',
      currentPlan: [],
      blockers: [],
      nextSteps: [],
      updatedAt: '2026-03-22T18:00:00.000Z',
    },
    entries: [second],
    dailyAudit: ['promote entry'],
  });

  const coldPath = join(tempDir, resolveMemoryRelativePath({
    layer: second.layer,
    category: second.category,
    dedupeKey: second.dedupeKey,
  }));
  assert.equal(existsSync(warmPath), false);
  assert.ok(existsSync(coldPath));
  assert.equal(
    store.readEntries().filter((entry) => entry.dedupeKey === first.dedupeKey).length,
    1,
  );
});

test('dedupe keys stay stable across minor wording changes', () => {
  const first = routeMemoryCandidate({
    title: 'Long-Term Principle',
    summary: 'Transcript remains the source of truth and should always stay canonical.',
    category: 'system-principles',
    scope: 'system',
    persistence: 'long_term',
    recurrence: 2,
    connectivity: 3,
    activationEnergy: 'high',
  });
  const second = routeMemoryCandidate({
    title: 'Long-Term Principle',
    summary: 'The transcript should always remain the source of truth for canonical state.',
    category: 'system-principles',
    scope: 'system',
    persistence: 'long_term',
    recurrence: 2,
    connectivity: 3,
    activationEnergy: 'high',
  });

  assert.equal(first.dedupeKey, second.dedupeKey);
});

test('routeLayeredMemory preserves the prior hot current-task summary when the latest intent is only a recall question', () => {
  const now = '2026-03-23T08:30:00.000Z';
  const flushPlan = routeLayeredMemory({
    sessionId: 'recall-intent-session',
    reason: 'turn_end',
    now,
    nodes: [],
    taskState: {
      sessionId: 'recall-intent-session',
      intent: 'What is the current task and the next step I asked you to remember?',
      constraints: [],
      activeDecisions: [],
      candidateDecisions: [],
      toolFacts: [],
      artifactState: [],
      priorityBacklog: [],
      priorityStatus: [],
      openLoops: [],
      resolvedOpenLoops: [],
      relevantMemories: [],
      confidence: 0.9,
      lastUpdatedAt: now,
    },
    existingEntries: [
      {
        layer: 'hot',
        scope: 'task',
        sourceFile: 'memory/hot/current-task.md',
        title: 'Current Task State',
        summary: 'Validate Hypergraph Context Engine on Ubuntu',
        abstract: 'Current Task State',
        overview: 'Current Task State: Validate Hypergraph Context Engine on Ubuntu',
        text: 'Validate Hypergraph Context Engine on Ubuntu',
        category: 'current-task',
        routeReason: 'Current task state',
        dedupeKey: 'current-task-state',
        persistence: 'task',
        recurrence: 2,
        connectivity: 2,
        activationEnergy: 'low',
        status: 'active',
        updatedAt: '2026-03-23T08:00:00.000Z',
      },
    ],
  });

  const currentTaskEntry = flushPlan.entries.find((entry) => entry.category === 'current-task');

  assert.equal(flushPlan.nowState.currentTask, null);
  assert.equal(currentTaskEntry?.summary, 'Validate Hypergraph Context Engine on Ubuntu');
});

test('retrieveRelevantNodes ranks hot memory above warm and cold memory', () => {
  const nodes: BaseNode[] = [
    createMemoryNode('memory/hot/current-task.md', 'hot', 'Current task state', 'Implement layered memory now'),
    createMemoryNode('memory/warm/pattern.md', 'warm', 'Reusable pattern', 'Implement layered memory with a reusable workflow'),
    createMemoryNode('memory/cold/system-principles.md', 'cold', 'System principle', 'Implement layered memory while transcript stays canonical'),
  ];
  const taskState = materializeTaskState('memory-ranking-session', nodes, []);
  const retrieved = retrieveRelevantNodes({
    nodes,
    taskState,
    currentTurnText: 'implement layered memory',
    limit: 3,
  });

  assert.equal(retrieved.selectedNodeIds[0], 'memory:memory/hot/current-task.md');
  assert.equal(retrieved.selectedNodeIds[1], 'memory:memory/warm/pattern.md');
  assert.equal(retrieved.selectedNodeIds[2], 'memory:memory/cold/system-principles.md');
});

test('retrieveRelevantNodes prefers session then agent then workspace memory before global memory', () => {
  const nodes: BaseNode[] = [
    createMemoryNode(
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
    createMemoryNode(
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
    createMemoryNode(
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
    createMemoryNode(
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
  const taskState = materializeTaskState('current-session', nodes, []);
  const retrieved = retrieveRelevantNodes({
    nodes,
    taskState,
    currentTurnText: 'What is the current task and next step?',
    limit: 4,
    memoryNamespace: {
      sessionId: 'current-session',
      agentId: 'agent-blue',
      workspaceId: '/workspace/blue',
    },
  });

  assert.deepEqual(retrieved.selectedNodeIds, [
    'memory:memory/warm/session-memory.md',
    'memory:memory/warm/agent-memory.md',
    'memory:memory/warm/workspace-memory.md',
    'memory:memory/cold/global-memory.md',
  ]);
});

test('repository query gate can skip long-term memory or keep only session-hot memory', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'layered-memory-query-gate-'));
  const store = new LayeredMemoryWorkspaceStore(tempDir);
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

  const repository = new WorkspaceMemoryRepository(tempDir);
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

  assert.ok(sessionHotOnly.entries.every((entry) => entry.layer === 'hot' && entry.lastSessionId === 'session-alpha'));
  assert.equal(transcriptOnly.entries.length, 0);
  assert.equal(transcriptOnly.nodes.length, 0);
});

test('repository projects L0/L1 by default and unlocks L2 for detail-seeking queries', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'layered-memory-detail-levels-'));
  const repository = new WorkspaceMemoryRepository(tempDir);
  const now = '2026-03-25T09:00:00.000Z';

  repository.flush({
    sessionId: 'detail-session',
    agentId: 'agent-detail',
    workspaceId: '/workspace/detail',
    reason: 'manual_save',
    nodes: [],
    taskState: {
      ...materializeTaskState('detail-session', [], []),
      sessionId: 'detail-session',
      intent: 'Current task: document the full implementation details for the scoped retrieval pipeline.',
      activeDecisions: ['Use L0 and L1 by default, and only unlock L2 for detail-seeking queries.'],
      toolFacts: ['Detailed evidence should remain available for deep-dive questions.'],
      lastUpdatedAt: now,
    },
  });

  const continuationRead = repository.read({
    sessionId: 'detail-session',
    agentId: 'agent-detail',
    workspaceId: '/workspace/detail',
    queryGateMode: 'session_hot_only',
    queryText: 'What is the current task and next step?',
  });
  const detailRead = repository.read({
    sessionId: 'detail-session',
    agentId: 'agent-detail',
    workspaceId: '/workspace/detail',
    queryText: 'Show me the full implementation details and exact evidence for the scoped retrieval pipeline.',
  });

  assert.ok(continuationRead.entries.every((entry) => entry.selectedDetailLevel !== 'L2'));
  assert.ok(detailRead.entries.some((entry) => entry.selectedDetailLevel === 'L2'));
});

test('engine flushes markdown memory and a fresh engine can hydrate it back into assemble', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'layered-memory-engine-'));
  const writer = new HypergraphContextEngine({
    memoryWorkspaceRoot: tempDir,
    enableLayeredRead: true,
    enableLayeredWrite: true,
    flushOnAfterTurn: false,
    flushOnCompact: true,
  });

  await writer.ingestMany(toySessionId, toyTranscript);
  const flushResult = await writer.flushMemory(toySessionId, 'manual_save');
  assert.ok(flushResult.writtenFiles.length > 0);

  const reader = new HypergraphContextEngine({
    memoryWorkspaceRoot: tempDir,
    enableLayeredRead: true,
    enableLayeredWrite: false,
    flushOnAfterTurn: false,
    flushOnCompact: false,
  });
  const assembled = await reader.assemble({
    sessionId: toySessionId,
    currentTurnText: 'recover layered memory from markdown',
    tokenBudget: 300,
  });

  const snapshot = reader.debugSession(toySessionId);
  const hydratedMemory = reader.hydrateMemory(toySessionId);
  assert.equal(snapshot?.nodes.some((node) => node.kind === 'memory_chunk'), false);
  assert.ok(hydratedMemory.some((node) => node.kind === 'memory_chunk'));
  assert.ok(assembled.taskState?.relevantMemories.length);
  assert.ok(
    assembled.retrievalSummary?.some((candidate) => candidate.layer === 'hot' && candidate.sourceFile?.includes('SESSION_NOW.md')),
  );

  await writer.compact(toySessionId);
  assert.ok(existsSync(join(tempDir, '.hypergraph-memory', 'archive', 'daily', '2026-03-22.md')));
});

test('WorkspaceMemoryRepository flushes and reloads layered memory through workspace files', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'layered-memory-repository-'));
  const engine = new HypergraphContextEngine();

  await engine.ingestMany(toySessionId, toyTranscript);
  const snapshot = engine.debugSession(toySessionId);
  assert.ok(snapshot);

  const repository = new WorkspaceMemoryRepository(tempDir);
  const taskState = materializeTaskState(toySessionId, snapshot!.nodes, snapshot!.edges);
  const flushResult = repository.flush({
    sessionId: toySessionId,
    taskState,
    nodes: snapshot!.nodes,
    reason: 'manual_save',
  });
  const readResult = repository.read({ sessionId: toySessionId });

  assert.ok(flushResult.writtenFiles.some((file) => file.endsWith('SESSION_NOW.md')));
  assert.ok(readResult.entries.length > 0);
  assert.ok(readResult.nodes.every((node) => node.kind === 'memory_chunk'));
});

test('WorkspaceMemoryRepository maintenance promotes qualifying entries across layers and rewrites files', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'layered-memory-maintain-'));
  const store = new LayeredMemoryWorkspaceStore(tempDir);
  const repository = new WorkspaceMemoryRepository(tempDir);
  const now = '2026-03-23T09:00:00.000Z';

  store.writeFlush({
    nowState: {
      currentTask: 'maintain layered memory',
      currentPlan: [],
      blockers: [],
      nextSteps: [],
      updatedAt: now,
    },
    entries: [
      {
        ...routeMemoryCandidate({
          title: 'Current Task State',
          summary: 'Implement layered memory maintenance',
          category: 'current-task',
          scope: 'task',
          persistence: 'task',
          recurrence: 3,
          connectivity: 3,
          activationEnergy: 'low',
        }),
        updatedAt: now,
        firstSeenAt: '2026-03-20T09:00:00.000Z',
        hitCount: 3,
        sessionCount: 2,
        lastSessionId: toySessionId,
        sourceFile: '',
      },
      {
        ...routeMemoryCandidate({
          title: 'Reusable Pattern',
          summary: 'Use a reusable workflow for flush and hydrate memory.',
          category: 'pattern',
          scope: 'workflow',
          persistence: 'project',
          recurrence: 4,
          connectivity: 4,
          activationEnergy: 'medium',
        }),
        updatedAt: now,
        firstSeenAt: '2026-03-01T09:00:00.000Z',
        hitCount: 4,
        sessionCount: 3,
        lastSessionId: toySessionId,
        sourceFile: '',
      },
    ],
    dailyAudit: ['seed maintenance entries'],
  });

  const maintenance = repository.maintain({
    sessionId: toySessionId,
    now,
  });

  const warmPath = join(tempDir, resolveMemoryRelativePath({
    layer: 'warm',
    category: 'current-task',
    dedupeKey: routeMemoryCandidate({
      title: 'Current Task State',
      summary: 'Implement layered memory maintenance',
      category: 'current-task',
      scope: 'task',
      persistence: 'task',
      recurrence: 3,
      connectivity: 3,
      activationEnergy: 'low',
    }).dedupeKey,
  }));
  const coldPath = join(tempDir, resolveMemoryRelativePath({
    layer: 'cold',
    category: 'pattern',
    dedupeKey: routeMemoryCandidate({
      title: 'Reusable Pattern',
      summary: 'Use a reusable workflow for flush and hydrate memory.',
      category: 'pattern',
      scope: 'workflow',
      persistence: 'project',
      recurrence: 4,
      connectivity: 4,
      activationEnergy: 'medium',
    }).dedupeKey,
  }));

  assert.ok(maintenance.writtenFiles.includes(resolveMemoryCoreRelativePath()));
  assert.equal(existsSync(join(tempDir, resolveMemoryRelativePath({
    layer: 'hot',
    category: 'current-task',
    dedupeKey: routeMemoryCandidate({
      title: 'Current Task State',
      summary: 'Implement layered memory maintenance',
      category: 'current-task',
      scope: 'task',
      persistence: 'task',
      recurrence: 3,
      connectivity: 3,
      activationEnergy: 'low',
    }).dedupeKey,
    lastSessionId: toySessionId,
  }))), false);
  assert.ok(existsSync(warmPath));
  assert.ok(existsSync(coldPath));
  assert.ok(maintenance.entries.some((entry) => entry.layer === 'warm' && entry.title === 'Current Task State'));
  assert.ok(maintenance.entries.some((entry) => entry.layer === 'cold' && entry.title === 'Reusable Pattern'));
});

test('WorkspaceMemoryRepository maintenance preserves namespace NOW documents and daily audit logs', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'layered-memory-maintain-now-'));
  const store = new LayeredMemoryWorkspaceStore(tempDir);
  const repository = new WorkspaceMemoryRepository(tempDir);
  const now = '2026-03-24T10:30:00.000Z';

  store.writeFlush({
    nowState: {
      currentTask: 'Preserve session now documents during maintenance',
      currentPlan: ['Keep SESSION_NOW.md intact'],
      blockers: [],
      nextSteps: ['Verify maintenance no longer deletes NOW or daily logs'],
      updatedAt: now,
      lastSessionId: 'session-preserve-now',
      lastAgentId: 'agent-preserve-now',
      lastWorkspaceId: '/workspace/preserve-now',
    },
    entries: [{
      ...routeMemoryCandidate({
        title: 'Current Task State',
        summary: 'Preserve session now documents during maintenance',
        category: 'current-task',
        scope: 'task',
        persistence: 'task',
        recurrence: 3,
        connectivity: 3,
        activationEnergy: 'low',
      }),
      updatedAt: now,
      firstSeenAt: '2026-03-20T10:30:00.000Z',
      hitCount: 3,
      sessionCount: 2,
      lastSessionId: 'session-preserve-now',
      lastAgentId: 'agent-preserve-now',
      lastWorkspaceId: '/workspace/preserve-now',
      sourceFile: '',
    }],
    dailyAudit: ['seed maintenance preservation test'],
  });

  repository.maintain({
    sessionId: 'session-preserve-now',
    agentId: 'agent-preserve-now',
    workspaceId: '/workspace/preserve-now',
    now,
  });

  assert.ok(existsSync(join(tempDir, resolveNowRelativePath({
    sessionId: 'session-preserve-now',
    agentId: 'agent-preserve-now',
    workspaceId: '/workspace/preserve-now',
  }))));
  assert.ok(existsSync(join(tempDir, '.hypergraph-memory', 'archive', 'daily', '2026-03-24.md')));
});

test('engine afterTurn triggers maintenance writeback when promoteOnMaintenance is enabled', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'layered-memory-afterturn-'));
  const store = new LayeredMemoryWorkspaceStore(tempDir);
  const now = '2026-03-23T10:00:00.000Z';

  store.writeFlush({
    nowState: {
      currentTask: 'afterTurn maintenance',
      currentPlan: [],
      blockers: [],
      nextSteps: [],
      updatedAt: now,
    },
    entries: [{
      ...routeMemoryCandidate({
        title: 'Current Task State',
        summary: 'Stabilize afterTurn maintenance',
        category: 'current-task',
        scope: 'task',
        persistence: 'task',
        recurrence: 3,
        connectivity: 3,
        activationEnergy: 'low',
      }),
      updatedAt: now,
      firstSeenAt: '2026-03-20T10:00:00.000Z',
      hitCount: 3,
      sessionCount: 2,
      lastSessionId: toySessionId,
      sourceFile: '',
    }],
    dailyAudit: ['seed hot entry for afterTurn'],
  });

  const engine = new HypergraphContextEngine({
    memoryWorkspaceRoot: tempDir,
    enableLayeredRead: true,
    enableLayeredWrite: false,
    flushOnAfterTurn: false,
    flushOnCompact: false,
    promoteOnMaintenance: true,
  });

  await engine.afterTurn('maintenance-only-session');

  assert.equal(existsSync(join(tempDir, resolveMemoryRelativePath({
    layer: 'hot',
    category: 'current-task',
    dedupeKey: routeMemoryCandidate({
      title: 'Current Task State',
      summary: 'Stabilize afterTurn maintenance',
      category: 'current-task',
      scope: 'task',
      persistence: 'task',
      recurrence: 3,
      connectivity: 3,
      activationEnergy: 'low',
    }).dedupeKey,
    lastSessionId: toySessionId,
  }))), false);
  assert.ok(existsSync(join(tempDir, resolveMemoryRelativePath({
    layer: 'warm',
    category: 'current-task',
    dedupeKey: routeMemoryCandidate({
      title: 'Current Task State',
      summary: 'Stabilize afterTurn maintenance',
      category: 'current-task',
      scope: 'task',
      persistence: 'task',
      recurrence: 3,
      connectivity: 3,
      activationEnergy: 'low',
    }).dedupeKey,
  }))));
});

test('routeLayeredMemory emits hot entries from current task state and stable principles into colder tiers', () => {
  const state = materializeTaskState('route-session', toyTranscript.flatMap((entry) => []), []);
  const taskState = {
    ...state,
    intent: 'Implement the layered memory prototype',
    activeDecisions: ['We will use a reusable workflow for flush and hydrate memory.', 'Transcript remains source of truth.'],
    constraints: ['Always keep transcript as source of truth.'],
    toolFacts: ['memory flush: wrote NOW.md and hot memory'],
    openLoops: ['Add lifecycle regression tests later.'],
  };

  const routed = routeLayeredMemory({
    sessionId: 'route-session',
    taskState,
    nodes: [],
    reason: 'manual_save',
    now: '2026-03-22T18:00:00.000Z',
  });

  assert.ok(routed.entries.some((entry) => entry.layer === 'hot'));
  assert.ok(routed.entries.some((entry) => entry.layer === 'warm'));
  assert.ok(routed.entries.some((entry) => entry.layer === 'cold'));
});

test('routeLayeredMemory extracts user preference and agent experience candidates into scoped memory', () => {
  const now = '2026-03-25T10:00:00.000Z';
  const nodes: BaseNode[] = [
    {
      id: 'u-pref',
      kind: 'message',
      sessionId: 'memory-self-iteration',
      createdAt: now,
      payload: {
        role: 'user',
        text: 'Please always reply with concise bullet points and remember that I prefer transcript-first debugging.',
      },
    },
    {
      id: 'a-exp',
      kind: 'message',
      sessionId: 'memory-self-iteration',
      createdAt: '2026-03-25T10:00:10.000Z',
      payload: {
        role: 'assistant',
        text: 'We should reuse the slot-safe selection pattern and keep semantic augmentation in systemPromptAddition.',
      },
    },
    {
      id: 'tool-exp',
      kind: 'tool_result',
      sessionId: 'memory-self-iteration',
      createdAt: '2026-03-25T10:00:20.000Z',
      payload: {
        text: 'Tool result: the scoped retrieval workflow stayed stable after the validation pass.',
      },
    },
  ];

  const routed = routeLayeredMemory({
    sessionId: 'memory-self-iteration',
    agentId: 'agent-memory',
    workspaceId: '/workspace/memory',
    now,
    reason: 'turn_end',
    nodes,
    taskState: {
      ...materializeTaskState('memory-self-iteration', nodes, []),
      sessionId: 'memory-self-iteration',
      intent: 'Current task: stabilize scoped memory self-iteration.',
      lastUpdatedAt: now,
    },
  });

  assert.ok(routed.entries.some((entry) => entry.category === 'user-profile' && entry.scope === 'user'));
  assert.ok(routed.entries.some((entry) => entry.category === 'agent-experience' && entry.scope === 'workflow'));
});

test('routeLayeredMemory deduplicates completed next-step echoes and keeps them out of blockers', () => {
  const now = '2026-03-26T01:00:00.000Z';
  const nodes: BaseNode[] = [
    {
      id: 'u-task',
      kind: 'message',
      sessionId: 'now-dedupe-session',
      createdAt: now,
      payload: {
        role: 'user',
        text: 'Current task: reconnect hypergraph context engine. Next step: confirm scoped memory files are written.',
      },
    },
    {
      id: 'a-ack',
      kind: 'message',
      sessionId: 'now-dedupe-session',
      createdAt: '2026-03-26T01:00:05.000Z',
      payload: {
        role: 'assistant',
        text: 'Stored. Current task: reconnect hypergraph context engine. Next step: confirm scoped memory files are written ✅',
      },
    },
  ];

  const routed = routeLayeredMemory({
    sessionId: 'now-dedupe-session',
    agentId: 'main',
    workspaceId: '/workspace/hypergraph',
    now,
    reason: 'turn_end',
    nodes,
    taskState: {
      ...materializeTaskState('now-dedupe-session', nodes, []),
      sessionId: 'now-dedupe-session',
      intent: 'Current task: reconnect hypergraph context engine. Next step: confirm scoped memory files are written.',
      openLoops: ['confirm scoped memory files are written ✅ (complete)'],
      priorityBacklog: ['confirm scoped memory files are written'],
      lastUpdatedAt: now,
    },
  });

  assert.equal(routed.nowState.currentTask, 'reconnect hypergraph context engine');
  assert.deepEqual(routed.nowState.blockers, []);
  assert.deepEqual(routed.nowState.nextSteps, ['confirm scoped memory files are written']);
});

function createMemoryNode(
  relativePath: string,
  layer: MemoryChunkPayload['layer'],
  title: string,
  summary: string,
  namespace: {
    lastSessionId?: string;
    lastAgentId?: string;
    lastWorkspaceId?: string;
  } = {},
): BaseNode {
  return {
    id: `memory:${relativePath}`,
    kind: 'memory_chunk',
    sessionId: 'memory-ranking-session',
    createdAt: '2026-03-22T00:00:00.000Z',
    tags: ['memory', layer],
    payload: {
      layer,
      scope: layer === 'cold' ? 'system' : 'workflow',
      sourceFile: relativePath,
      title,
      summary,
      abstract: title,
      overview: `${title}: ${summary}`,
      detail: `${title}: ${summary}`,
      text: summary,
      dedupeKey: relativePath.replace(/[/.]+/g, '-'),
      persistence: layer === 'cold' ? 'long_term' : 'project',
      recurrence: layer === 'hot' ? 1 : 3,
      connectivity: layer === 'hot' ? 2 : 4,
      activationEnergy: layer === 'hot' ? 'low' : layer === 'warm' ? 'medium' : 'high',
      status: 'active',
      updatedAt: '2026-03-22T00:00:00.000Z',
      ...namespace,
    } satisfies MemoryChunkPayload,
  };
}
