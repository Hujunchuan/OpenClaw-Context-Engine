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
import { resolveMemoryRelativePath, routeLayeredMemory, routeMemoryCandidate } from '../../src/memory/router.js';
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
        sourceFile: '',
        relativePath: 'memory/cold/system-principles.md',
      },
    ],
    dailyAudit: ['Flush reason: manual_save', 'Wrote layered entries: hot, warm, cold'],
  };

  const result = store.writeFlush(flushPlan);
  const entries = store.readEntries();
  const indexed = indexLayeredMemoryEntries(toySessionId, entries);

  assert.ok(result.writtenFiles.includes('NOW.md'));
  assert.ok(result.writtenFiles.some((file) => file.startsWith('memory/hot/')));
  assert.ok(result.writtenFiles.some((file) => file.startsWith('memory/warm/')));
  assert.ok(result.writtenFiles.some((file) => file.startsWith('memory/cold/')));
  assert.ok(existsSync(join(tempDir, 'MEMORY.md')));
  assert.ok(indexed.some((node) => (node.payload as MemoryChunkPayload).layer === 'hot'));
  assert.ok(indexed.some((node) => (node.payload as MemoryChunkPayload).layer === 'warm'));
  assert.ok(indexed.some((node) => (node.payload as MemoryChunkPayload).layer === 'cold'));
  assert.match(readFileSync(join(tempDir, 'MEMORY.md'), 'utf8'), /Curated Long-Term Memory/);
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
    assembled.retrievalSummary?.some((candidate) => candidate.layer === 'hot' && candidate.sourceFile?.includes('NOW.md')),
  );

  await writer.compact(toySessionId);
  assert.ok(existsSync(join(tempDir, 'memory', '2026-03-22.md')));
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

  assert.ok(flushResult.writtenFiles.includes('NOW.md'));
  assert.ok(readResult.entries.length > 0);
  assert.ok(readResult.nodes.every((node) => node.kind === 'memory_chunk'));
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

function createMemoryNode(relativePath: string, layer: MemoryChunkPayload['layer'], title: string, summary: string): BaseNode {
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
      text: summary,
      dedupeKey: relativePath.replace(/[/.]+/g, '-'),
      persistence: layer === 'cold' ? 'long_term' : 'project',
      recurrence: layer === 'hot' ? 1 : 3,
      connectivity: layer === 'hot' ? 2 : 4,
      activationEnergy: layer === 'hot' ? 'low' : layer === 'warm' ? 'medium' : 'high',
      status: 'active',
      updatedAt: '2026-03-22T00:00:00.000Z',
    } satisfies MemoryChunkPayload,
  };
}
