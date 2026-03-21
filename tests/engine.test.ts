import test from 'node:test';
import assert from 'node:assert/strict';

import { HypergraphContextEngine } from '../src/engine.js';
import { assembleContext } from '../src/assemble.js';
import { compactSession } from '../src/compact.js';
import { extractNodes } from '../src/ingest.js';
import { retrieveRelevantNodes } from '../src/retriever.js';
import { SQLiteStore } from '../src/sqlite-store.js';
import { createEmptyTaskState, materializeTaskState } from '../src/task-state.js';
import { branchingSessionId, branchingTranscript } from '../fixtures/branching-transcript.js';
import { toySessionId, toyTranscript } from '../fixtures/toy-transcript.js';

test('createEmptyTaskState provides safe fallback defaults', () => {
  const state = createEmptyTaskState('empty-session', '2026-03-21T00:00:00.000Z');

  assert.equal(state.sessionId, 'empty-session');
  assert.equal(state.intent, null);
  assert.deepEqual(state.constraints, []);
  assert.deepEqual(state.activeDecisions, []);
  assert.deepEqual(state.openLoops, []);
  assert.deepEqual(state.resolvedOpenLoops, []);
  assert.equal(state.confidence, 0);
  assert.equal(state.lastUpdatedAt, '2026-03-21T00:00:00.000Z');
});

test('extractNodes derives semantic nodes from transcript entries', () => {
  const nodes = extractNodes(toySessionId, toyTranscript[3]!);
  const kinds = nodes.map((node) => node.kind).sort();

  assert.deepEqual(kinds, ['artifact_snapshot', 'decision', 'message', 'open_loop']);
});

test('ingest keeps explicit transcript parent links for branching conversations', async () => {
  const engine = new HypergraphContextEngine();

  await engine.ingestMany(branchingSessionId, branchingTranscript);

  const snapshot = engine.debugSession(branchingSessionId);
  assert.ok(snapshot);

  const branchUserEdge = snapshot?.edges.find((edge) => edge.from === 'u2:message' && edge.kind === 'responds_to');
  const assistantReplyEdge = snapshot?.edges.find((edge) => edge.from === 'a2:message' && edge.kind === 'responds_to');

  assert.equal(branchUserEdge?.to, 'a1:message');
  assert.equal(branchUserEdge?.reason, 'Explicit transcript parent');
  assert.equal(assistantReplyEdge?.to, 'u2:message');
  assert.equal(assistantReplyEdge?.reason, 'Explicit transcript parent');
});

test('ingest adds heuristic resolves, supersedes, and depends_on edges', async () => {
  const engine = new HypergraphContextEngine();

  await engine.ingestMany(branchingSessionId, branchingTranscript);

  const snapshot = engine.debugSession(branchingSessionId);
  assert.ok(snapshot);

  const resolvesEdge = snapshot?.edges.find((edge) => edge.kind === 'resolves' && edge.from === 'a2:decision');
  const dependsOnEdge = snapshot?.edges.find((edge) => edge.kind === 'depends_on' && edge.from === 'a2:artifact');
  const supersedesEdge = snapshot?.edges.find((edge) => edge.kind === 'supersedes' && edge.from === 'a2:decision');

  assert.equal(resolvesEdge?.to, 'u2:open-loop');
  assert.equal(dependsOnEdge?.to, 'a1:decision');
  assert.equal(supersedesEdge?.to, 'a1:decision');
});

test('materializeTaskState recovers intent, decisions, constraints, and open loops', () => {
  const nodes = toyTranscript.flatMap((entry) => extractNodes(toySessionId, entry));
  const state = materializeTaskState(toySessionId, nodes);

  assert.match(state.intent ?? '', /Build the Hypergraph Context Engine MVP/);
  assert.ok(state.constraints.some((value) => value.includes('transcript tree remains source of truth')));
  assert.ok(state.activeDecisions.some((value) => value.includes('implement task-state materialization first')));
  assert.ok(state.openLoops.some((value) => value.includes('SQLite storage later')));
  assert.deepEqual(state.resolvedOpenLoops, []);
  assert.equal(state.confidence, 1);
});

test('assembleContext degrades safely when no snapshot exists', () => {
  const result = assembleContext(undefined, {
    sessionId: 'missing-session',
    currentTurnText: 'anything',
    tokenBudget: 200,
  });

  assert.deepEqual(result.messages, []);
  assert.match(result.systemPromptAddition ?? '', /fallback assemble/);
  assert.equal(result.taskState.sessionId, 'missing-session');
  assert.equal(result.buckets.length, 5);
  assert.deepEqual(result.retrievalSummary, []);
});

test('engine end-to-end ingest, assemble, and compact keeps SQLite follow-up visible', async () => {
  const engine = new HypergraphContextEngine();

  await engine.ingestMany(toySessionId, toyTranscript);

  const assembled = await engine.assemble({
    sessionId: toySessionId,
    currentTurnText: 'implement assemble and capture the sqlite next step',
    tokenBudget: 500,
  });

  assert.ok(assembled.messages.length > 0);
  assert.match(assembled.systemPromptAddition ?? '', /Buckets:/);
  assert.match(assembled.systemPromptAddition ?? '', /Open loops:/);
  assert.ok(assembled.taskState?.intent);
  assert.ok(assembled.bucketSummary?.some((bucket) => bucket.count > 0));
  assert.ok(assembled.retrievalSummary?.length);
  assert.equal(assembled.retrievalSummary?.[0]?.selected, true);

  const compacted = await engine.compact(toySessionId);
  assert.ok(compacted.summaryNodeId);

  const snapshot = engine.debugSession(toySessionId);
  assert.ok(snapshot);

  const summaryNode = snapshot?.nodes.find((node) => node.id === compacted.summaryNodeId);
  assert.ok(summaryNode);
  assert.equal(summaryNode?.kind, 'summary');

  const payload = summaryNode?.payload as {
    openLoopsRemaining?: string[];
    evidenceRefs?: string[];
  };

  assert.ok(payload.evidenceRefs && payload.evidenceRefs.length > 0);
  assert.ok(
    payload.openLoopsRemaining?.some((value) => value.includes('SQLite-backed storage')),
    'compaction should preserve explicit SQLite follow-up',
  );
});

test('compactSession emits a traceable summary payload', () => {
  const nodes = toyTranscript.flatMap((entry) => extractNodes(toySessionId, entry));
  const snapshot = {
    sessionId: toySessionId,
    transcriptEntries: toyTranscript,
    nodes,
    edges: [],
  };

  const compacted = compactSession(snapshot);
  const payload = compacted.summaryNode.payload as {
    branchRoot?: string;
    summaryId?: string;
    evidenceRefs?: string[];
  };

  assert.equal(payload.branchRoot, 'u1');
  assert.ok(payload.summaryId?.startsWith(`${toySessionId}:summary:`));
  assert.ok(payload.evidenceRefs && payload.evidenceRefs.length > 0);
});

test('retrieveRelevantNodes ranks task-state nodes ahead of generic context', () => {
  const engine = new HypergraphContextEngine();
  void engine.ingestMany(toySessionId, toyTranscript);
  const snapshot = engine.debugSession(toySessionId);
  const nodes = snapshot?.nodes ?? toyTranscript.flatMap((entry) => extractNodes(toySessionId, entry));
  const taskState = materializeTaskState(toySessionId, nodes);
  const retrieved = retrieveRelevantNodes({
    nodes,
    edges: snapshot?.edges,
    taskState,
    currentTurnText: 'implement assemble and sqlite next step',
    limit: 5,
  });

  assert.equal(retrieved.selectedNodeIds.length, 5);
  assert.ok(retrieved.candidates[0]);
  assert.ok(
    retrieved.candidates.slice(0, 3).some((candidate) => candidate.nodeId.includes('decision') || candidate.nodeId.includes('open-loop')),
  );
});

test('edge-aware retrieval boosts connected decision and artifact nodes', async () => {
  const engine = new HypergraphContextEngine();
  await engine.ingestMany(toySessionId, toyTranscript);
  const snapshot = engine.debugSession(toySessionId);
  assert.ok(snapshot);

  const taskState = materializeTaskState(toySessionId, snapshot!.nodes, snapshot!.edges);
  const retrieved = retrieveRelevantNodes({
    nodes: snapshot!.nodes,
    edges: snapshot!.edges,
    taskState,
    currentTurnText: 'sqlite next step',
    limit: 6,
  });

  const topIds = retrieved.candidates.slice(0, 4).map((candidate) => candidate.nodeId);
  assert.ok(topIds.includes('a2:decision'));
  assert.ok(topIds.includes('a2:artifact'));
});

test('engine can hydrate from SQLite-backed session state', async () => {
  const store = new SQLiteStore(':memory:');
  const writer = new HypergraphContextEngine({ store });

  await writer.ingestMany(toySessionId, toyTranscript);

  await writer.compact(toySessionId);

  const reader = new HypergraphContextEngine({ store });
  const assembled = await reader.assemble({
    sessionId: toySessionId,
    currentTurnText: 'recover sqlite-backed assemble context',
    tokenBudget: 400,
  });

  assert.ok(assembled.messages.length > 0);
  assert.match(assembled.systemPromptAddition ?? '', /Intent:/);
  assert.ok(assembled.retrievalSummary?.length);
  store.close();
});

test('engine supports one-shot ingestAndAssemble for first demo flow', async () => {
  const engine = new HypergraphContextEngine();
  const assembled = await engine.ingestAndAssemble(toySessionId, toyTranscript, {
    currentTurnText: 'ingest transcript and assemble demo context',
    tokenBudget: 420,
  });

  assert.ok(assembled.messages.length > 0);
  assert.ok(assembled.taskState?.intent);
  assert.ok(assembled.bucketSummary?.length);
  assert.ok(assembled.bucketSummary?.some((bucket) => bucket.name === 'task_state' && bucket.count > 0));
  assert.ok(assembled.retrievalSummary?.some((candidate) => candidate.kind));
});

test('branching fixture assembles visible follow-up loops for regression demos', async () => {
  const engine = new HypergraphContextEngine();
  const assembled = await engine.ingestAndAssemble(branchingSessionId, branchingTranscript, {
    currentTurnText: 'keep the golden fixture follow-up visible in the demo output',
    tokenBudget: 420,
  });

  assert.match(assembled.taskState?.intent ?? '', /toy transcript demo/i);
  assert.ok(
    assembled.taskState?.resolvedOpenLoops.some((value) => /golden regression snapshots later/i.test(value)),
    'branching fixture should surface the explicit regression follow-up as resolved historical context',
  );
  assert.ok(
    assembled.retrievalSummary?.some(
      (candidate) => candidate.selected && (candidate.kind === 'open_loop' || candidate.kind === 'decision'),
    ),
  );
});

test('SQLiteStore persists and reloads an assembled session snapshot', () => {
  const nodes = toyTranscript.flatMap((entry) => extractNodes(toySessionId, entry));
  const taskState = materializeTaskState(toySessionId, nodes);
  const store = new SQLiteStore(':memory:');

  store.saveSession({
    sessionId: toySessionId,
    transcriptEntries: toyTranscript,
    nodes,
    edges: [],
    taskState,
  });

  const restored = store.loadSession(toySessionId);
  store.close();

  assert.ok(restored);
  assert.equal(restored?.sessionId, toySessionId);
  assert.equal(restored?.transcriptEntries.length, toyTranscript.length);
  assert.equal(restored?.nodes.length, nodes.length);
  assert.equal(restored?.taskState?.intent, taskState.intent);
});
