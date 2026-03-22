import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HypergraphContextEngine } from '../../src/core/engine.js';
import { assembleContext } from '../../src/core/assemble.js';
import { compactSession } from '../../src/core/compact.js';
import { extractNodes } from '../../src/core/ingest.js';
import { retrieveRelevantNodes } from '../../src/core/retriever.js';
import { SQLiteStore } from '../../src/core/sqlite-store.js';
import { createEmptyTaskState, materializeTaskState } from '../../src/core/task-state.js';
import { branchingSessionId, branchingTranscript } from '../../fixtures/branching-transcript.js';
import { runAllDemoScenarios } from '../../fixtures/demo-scenarios.js';
import { toySessionId, toyTranscript } from '../../fixtures/toy-transcript.js';

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
  assert.equal(
    nodes.find((node) => node.kind === 'open_loop')?.payload.text,
    'wire src/assemble.ts and prepare a toy demo fixture.',
  );
});

test('extractNodes does not mark user priority requests as artifact snapshots unless they describe concrete artifacts', () => {
  const nodes = extractNodes(toySessionId, toyTranscript[0]!);
  const kinds = nodes.map((node) => node.kind).sort();

  assert.deepEqual(kinds, ['intent', 'message']);
});

test('extractNodes does not treat a user priority list as a standalone constraint without a concrete constraint cue', () => {
  const nodes = extractNodes('priority-only-session', {
    id: 'u-priority',
    role: 'user',
    type: 'message',
    createdAt: '2026-03-22T00:00:00.000Z',
    content: 'Build the MVP. Priority: 1) task-state 2) ingest 3) assemble.',
  });
  const kinds = nodes.map((node) => node.kind).sort();

  assert.deepEqual(kinds, ['intent', 'message']);
});

test('extractNodes keeps user artifact hints concrete instead of turning generic demo goals into artifact state', () => {
  const genericGoalNodes = extractNodes(branchingSessionId, branchingTranscript[0]!);
  const concretePreferenceNodes = extractNodes(branchingSessionId, branchingTranscript[6]!);

  assert.deepEqual(genericGoalNodes.map((node) => node.kind).sort(), ['constraint', 'intent', 'message']);
  assert.deepEqual(concretePreferenceNodes.map((node) => node.kind).sort(), ['intent', 'message']);
});

test('extractNodes trims assistant progress updates down to the actionable next-step open loop', () => {
  const nodes = extractNodes('next-step-open-loop-session', {
    id: 'a1',
    role: 'assistant',
    type: 'message',
    createdAt: '2026-03-22T12:00:00.000Z',
    content: 'Added fixtures/demo-scenarios.ts and updated toy-demo output. Next step: stabilize snapshot IDs for compact summaries.',
  });

  const openLoop = nodes.find((node) => node.kind === 'open_loop');
  const decision = nodes.find((node) => node.kind === 'decision');
  const artifact = nodes.find((node) => node.kind === 'artifact_snapshot');

  assert.equal(openLoop?.payload.text, 'stabilize snapshot IDs for compact summaries.');
  assert.equal(decision?.payload.summary, 'Added fixtures/demo-scenarios.ts and updated toy-demo output');
  assert.equal(artifact?.payload.summary, 'Added fixtures/demo-scenarios.ts and updated toy-demo output');
});

test('extractNodes trims blocked and todo suffixes out of assistant semantic state', () => {
  const nodes = extractNodes('blocked-progress-session', {
    id: 'a1',
    role: 'assistant',
    type: 'message',
    createdAt: '2026-03-22T12:10:00.000Z',
    content: 'Implemented src/compact.ts snapshot pruning for raw transcript nodes. Blocked on: branch-aware archival policy. TODO: add a tiny fixture regression for compact reopen behavior.',
  });

  const decision = nodes.find((node) => node.kind === 'decision');
  const artifact = nodes.find((node) => node.kind === 'artifact_snapshot');
  const openLoop = nodes.find((node) => node.kind === 'open_loop');

  assert.equal(decision?.payload.summary, 'Implemented src/compact.ts snapshot pruning for raw transcript nodes');
  assert.equal(artifact?.payload.summary, 'Implemented src/compact.ts snapshot pruning for raw transcript nodes');
  assert.equal(openLoop?.payload.text, 'add a tiny fixture regression for compact reopen behavior.');
});

test('extractNodes derives progress decisions from tool results for demo, compact, and git push steps', () => {
  const commitNodes = extractNodes('tool-progress-session', {
    id: 'tr-commit',
    role: 'tool',
    type: 'tool_result',
    createdAt: '2026-03-22T12:20:00.000Z',
    content: '28c2e79 feat(hypergraph-context-engine): resolve artifact-backed priority items',
  });
  const demoNodes = extractNodes('tool-progress-session', {
    id: 'tr-demo',
    role: 'tool',
    type: 'tool_result',
    createdAt: '2026-03-22T12:21:00.000Z',
    content: 'npm run demo:snapshots\n=== SCENARIO: toy-session ===',
  });
  const compactNodes = extractNodes('tool-progress-session', {
    id: 'tr-compact',
    role: 'tool',
    type: 'tool_result',
    createdAt: '2026-03-22T12:22:00.000Z',
    content: 'summary created for toy-session\nopen loops kept: 2\npruned 3 older raw nodes',
  });
  const pushNodes = extractNodes('tool-progress-session', {
    id: 'tr-push',
    role: 'tool',
    type: 'tool_result',
    createdAt: '2026-03-22T12:23:00.000Z',
    content: 'To github.com:example/hypergraph-context-engine.git\n   1234567..89abcde  master -> master',
  });

  assert.equal(commitNodes.find((node) => node.kind === 'decision')?.payload.summary, 'Committed changes: feat(hypergraph-context-engine): resolve artifact-backed priority items');
  assert.equal(demoNodes.find((node) => node.kind === 'decision')?.payload.summary, 'Ran toy demo fixtures');
  assert.equal(compactNodes.find((node) => node.kind === 'decision')?.payload.summary, 'Ran minimal compact session snapshot');
  assert.equal(pushNodes.find((node) => node.kind === 'decision')?.payload.summary, 'Pushed changes to GitHub');
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

test('ingest marks a related follow-up as invalidating a previously resolved open loop', async () => {
  const engine = new HypergraphContextEngine();
  const sessionId = 'reopened-follow-up-session';

  await engine.ingestMany(sessionId, [
    {
      id: 'u1',
      role: 'user',
      type: 'message',
      createdAt: '2026-03-22T03:00:00.000Z',
      content: 'Can you leave a follow up for SQLite fixture coverage later?',
    },
    {
      id: 'a1',
      parentId: 'u1',
      role: 'assistant',
      type: 'message',
      createdAt: '2026-03-22T03:01:00.000Z',
      content: 'Done: finished the SQLite fixture coverage follow-up and closed that loop.',
    },
    {
      id: 'u2',
      parentId: 'a1',
      role: 'user',
      type: 'message',
      createdAt: '2026-03-22T03:02:00.000Z',
      content: 'Actually, there is still a SQLite fixture coverage follow up for the branching demo later?',
    },
  ]);

  const snapshot = engine.debugSession(sessionId);
  const invalidatesEdge = snapshot?.edges.find((edge) => edge.kind === 'invalidates' && edge.from === 'u2:open-loop');

  assert.equal(invalidatesEdge?.to, 'u1:open-loop');
  assert.match(invalidatesEdge?.reason ?? '', /reopens/i);
});

test('ingest treats explicit completion language as a resolve signal for the latest assistant follow-up', async () => {
  const engine = new HypergraphContextEngine();
  const sessionId = 'resolution-cue-session';

  await engine.ingestMany(sessionId, [
    {
      id: 'u1',
      role: 'user',
      type: 'message',
      createdAt: '2026-03-22T02:00:00.000Z',
      content: 'Could you leave a clear open loop for SQLite storage later?',
    },
    {
      id: 'a1',
      parentId: 'u1',
      role: 'assistant',
      type: 'message',
      createdAt: '2026-03-22T02:01:00.000Z',
      content: 'Done: finished the SQLite storage follow-up and closed that loop.',
    },
  ]);

  const snapshot = engine.debugSession(sessionId);
  const resolvesEdge = snapshot?.edges.find((edge) => edge.kind === 'resolves' && edge.from === 'a1:decision');

  assert.equal(resolvesEdge?.to, 'u1:open-loop');
  assert.match(resolvesEdge?.reason ?? '', /resolved/i);
});

test('materializeTaskState recovers intent, decisions, constraints, and open loops', () => {
  const nodes = toyTranscript.flatMap((entry) => extractNodes(toySessionId, entry));
  const state = materializeTaskState(toySessionId, nodes);

  assert.match(state.intent ?? '', /Build the Hypergraph Context Engine MVP/);
  assert.ok(state.constraints.some((value) => value.includes('transcript tree remains source of truth')));
  assert.ok(state.activeDecisions.some((value) => value.includes('implement task-state materialization first')));
  assert.ok(state.openLoops.includes('wire src/assemble.ts and prepare a toy demo fixture.'));
  assert.ok(state.openLoops.some((value) => value.includes('SQLite storage later')));
  assert.deepEqual(state.resolvedOpenLoops, []);
  assert.equal(state.confidence, 1);
});

test('materializeTaskState avoids duplicating the top intent as a constraint', () => {
  const nodes = branchingTranscript.flatMap((entry) => extractNodes(branchingSessionId, entry));
  const state = materializeTaskState(branchingSessionId, nodes);

  assert.ok(state.intent);
  assert.ok(state.constraints.every((value) => value !== state.intent));
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

test('assembleContext seeds top candidate per bucket when budget allows', () => {
  const nodes = toyTranscript.flatMap((entry) => extractNodes(toySessionId, entry));
  const result = assembleContext(
    {
      sessionId: toySessionId,
      transcriptEntries: toyTranscript,
      nodes,
      edges: [],
    },
    {
      sessionId: toySessionId,
      currentTurnText: 'implement assemble and prepare toy demo fixture',
      tokenBudget: 320,
    },
  );

  const nonEmptyBuckets = result.buckets.filter((bucket) => bucket.nodeIds.length > 0).map((bucket) => bucket.name);
  assert.ok(nonEmptyBuckets.includes('task_state'));
  assert.ok(nonEmptyBuckets.includes('artifact'));
  assert.ok(nonEmptyBuckets.includes('recent_dialogue'));
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
  assert.ok(assembled.taskState?.priorityStatus);

  const compacted = await engine.compact(toySessionId);
  assert.ok(compacted.summaryNodeId);

  const snapshot = engine.debugSession(toySessionId);
  assert.ok(snapshot);

  const summaryNode = snapshot?.nodes.find((node) => node.id === compacted.summaryNodeId);
  assert.ok(summaryNode);
  assert.equal(summaryNode?.kind, 'summary');

  const payload = summaryNode?.payload as {
    priorityBacklog?: string[];
    priorityStatus?: Array<{ item?: string; status?: string }>;
    openLoopsRemaining?: string[];
    evidenceRefs?: string[];
  };

  assert.ok(payload.evidenceRefs && payload.evidenceRefs.length > 0);
  assert.ok(Array.isArray(payload.priorityBacklog));
  assert.ok(Array.isArray(payload.priorityStatus));
  assert.ok(
    payload.openLoopsRemaining?.some((value) => value.toLowerCase().includes('sqlite storage later')),
    'compaction should preserve the explicit SQLite follow-up from the transcript',
  );
  assert.ok(
    payload.openLoopsRemaining?.some((value) => value.includes('heuristic retrieval')),
    'compaction should add a fresh forward-looking follow-up instead of stale persistence TODOs',
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
    validUntil?: string;
  };

  assert.equal(payload.branchRoot, 'u1');
  assert.ok(payload.summaryId?.startsWith(`${toySessionId}:summary:`));
  assert.ok(payload.evidenceRefs && payload.evidenceRefs.length > 0);
  assert.ok(payload.validUntil);
});

test('materializeTaskState can recover from summary-only compacted state', () => {
  const nodes = toyTranscript.flatMap((entry) => extractNodes(toySessionId, entry));
  const compacted = compactSession({
    sessionId: toySessionId,
    transcriptEntries: toyTranscript,
    nodes,
    edges: [],
  });

  const summaryOnlyNodes = compacted.compactedSnapshot.nodes.filter((node) => node.kind === 'summary');
  const recovered = materializeTaskState(toySessionId, summaryOnlyNodes, []);

  assert.match(recovered.intent ?? '', /Build the Hypergraph Context Engine MVP/);
  assert.ok(recovered.activeDecisions.some((value) => value.includes('implement task-state materialization first')));
  assert.ok(recovered.artifactState.some((value) => value.includes('src/assemble.ts')));
  assert.ok(recovered.openLoops.some((value) => value.toLowerCase().includes('sqlite storage later')));
  assert.ok(recovered.openLoops.some((value) => value.includes('heuristic retrieval')));
  assert.equal(recovered.resolvedOpenLoops.length, 0);
  assert.ok(recovered.confidence > 0);
});

test('materializeTaskState prefers raw nodes over older summary state when both exist', () => {
  const recovered = materializeTaskState('raw-over-summary-session', [
    {
      id: 'summary:1',
      kind: 'summary',
      sessionId: 'raw-over-summary-session',
      createdAt: '2026-03-20T00:00:00.000Z',
      tags: ['summary'],
      payload: {
        summaryId: 'summary:1',
        branchRoot: 'u1',
        intent: 'ship the old MVP',
        constraints: ['old constraint'],
        finalDecisions: ['old decision'],
        candidateDecisions: ['prepare fallback plan'],
        toolFacts: ['sqlite: old snapshot'],
        evidenceRefs: [],
        artifactFinalState: ['old artifact'],
        openLoopsRemaining: ['old unresolved loop'],
        resolvedOpenLoops: [],
        validUntil: '2099-03-23T00:00:00.000Z',
        confidence: 0.8,
      },
    },
    {
      id: 'u1:intent',
      kind: 'intent',
      sessionId: 'raw-over-summary-session',
      createdAt: '2026-03-22T00:00:00.000Z',
      tags: ['intent'],
      payload: {
        text: 'ship the fresh MVP with SQLite compaction',
      },
    },
    {
      id: 'a1:decision',
      kind: 'decision',
      sessionId: 'raw-over-summary-session',
      createdAt: '2026-03-22T00:01:00.000Z',
      tags: ['decision'],
      payload: {
        text: 'fresh decision',
        status: 'active',
      },
    },
    {
      id: 'u2:open-loop',
      kind: 'open_loop',
      sessionId: 'raw-over-summary-session',
      createdAt: '2026-03-22T00:02:00.000Z',
      tags: ['open-loop'],
      payload: {
        text: 'fresh unresolved loop',
      },
    },
  ], []);

  assert.equal(recovered.intent, 'ship the fresh MVP with SQLite compaction');
  assert.equal(recovered.activeDecisions[0], 'fresh decision');
  assert.equal(recovered.openLoops[0], 'fresh unresolved loop');
  assert.ok(recovered.activeDecisions.includes('old decision'));
});

test('materializeTaskState drops candidate decisions once the same plan becomes active', () => {
  const recovered = materializeTaskState('candidate-dedupe-session', [
    {
      id: 'summary:1',
      kind: 'summary',
      sessionId: 'candidate-dedupe-session',
      createdAt: '2099-03-22T00:00:00.000Z',
      tags: ['summary'],
      payload: {
        summaryId: 'summary:1',
        branchRoot: 'u1',
        intent: 'finish the MVP',
        constraints: [],
        finalDecisions: [],
        candidateDecisions: ['Implement compact session'],
        toolFacts: [],
        evidenceRefs: [],
        artifactFinalState: [],
        openLoopsRemaining: [],
        resolvedOpenLoops: [],
        validUntil: '2099-03-23T00:00:00.000Z',
        confidence: 0.8,
      },
    },
    {
      id: 'a1:decision',
      kind: 'decision',
      sessionId: 'candidate-dedupe-session',
      createdAt: '2099-03-22T00:01:00.000Z',
      tags: ['decision'],
      payload: {
        text: 'Implemented compact session.',
        status: 'active',
      },
    },
  ], []);

  assert.ok(recovered.activeDecisions.some((value) => /implement/i.test(value)));
  assert.equal(recovered.candidateDecisions.length, 0);
});

test('materializeTaskState prefers non-expired summaries over stale compacted summaries', () => {
  const recovered = materializeTaskState('summary-validity-session', [
    {
      id: 'summary:expired',
      kind: 'summary',
      sessionId: 'summary-validity-session',
      createdAt: '2026-03-20T00:00:00.000Z',
      tags: ['summary'],
      payload: {
        summaryId: 'summary:expired',
        branchRoot: 'u1',
        intent: 'stale summary intent',
        constraints: ['old constraint'],
        finalDecisions: ['old decision'],
        candidateDecisions: [],
        toolFacts: [],
        evidenceRefs: [],
        artifactFinalState: [],
        openLoopsRemaining: ['old loop'],
        resolvedOpenLoops: [],
        validUntil: '2026-03-20T00:10:00.000Z',
        confidence: 0.8,
      },
    },
    {
      id: 'summary:valid',
      kind: 'summary',
      sessionId: 'summary-validity-session',
      createdAt: '2099-03-20T00:00:00.000Z',
      tags: ['summary'],
      payload: {
        summaryId: 'summary:valid',
        branchRoot: 'u1',
        intent: 'fresh summary intent',
        constraints: ['fresh constraint'],
        finalDecisions: ['fresh decision'],
        candidateDecisions: [],
        toolFacts: [],
        evidenceRefs: [],
        artifactFinalState: [],
        openLoopsRemaining: ['fresh loop'],
        resolvedOpenLoops: [],
        validUntil: '2099-03-21T00:10:00.000Z',
        confidence: 0.9,
      },
    },
  ], []);

  assert.equal(recovered.intent, 'fresh summary intent');
  assert.ok(recovered.activeDecisions.includes('fresh decision'));
  assert.ok(recovered.openLoops.includes('fresh loop'));
  assert.equal(recovered.confidence, 0.9);
});

test('compactSession prunes older raw transcript nodes while keeping semantic state', () => {
  const nodes = branchingTranscript.flatMap((entry) => extractNodes(branchingSessionId, entry));
  const snapshot = {
    sessionId: branchingSessionId,
    transcriptEntries: branchingTranscript,
    nodes,
    edges: [],
  };

  const compacted = compactSession(snapshot, {
    keepLastTranscriptEntries: 2,
    keepLastRawNodes: 2,
    keepSummaryNodes: 1,
  });

  assert.equal(compacted.compactedSnapshot.transcriptEntries.length, 2);
  assert.ok(compacted.compactedSnapshot.nodes.some((node) => node.kind === 'summary'));
  assert.ok(compacted.compactedSnapshot.nodes.some((node) => node.kind === 'decision'));
  assert.ok(compacted.compactedSnapshot.nodes.some((node) => node.kind === 'open_loop'));
  assert.ok(compacted.compactedSnapshot.nodes.filter((node) => node.kind === 'message').length <= 2);
});

test('materializeTaskState drops summary open loops once a related resolved loop is present', () => {
  const recovered = materializeTaskState('resolved-loop-reconciliation-session', [
    {
      id: 'summary:1',
      kind: 'summary',
      sessionId: 'resolved-loop-reconciliation-session',
      createdAt: '2099-03-22T00:00:00.000Z',
      tags: ['summary'],
      payload: {
        summaryId: 'summary:1',
        branchRoot: 'u1',
        intent: 'finish the MVP',
        constraints: [],
        finalDecisions: [],
        candidateDecisions: [],
        toolFacts: [],
        evidenceRefs: [],
        artifactFinalState: [],
        openLoopsRemaining: ['Need follow-up for SQLite storage later.'],
        resolvedOpenLoops: ['Finished the SQLite storage follow-up and closed that loop.'],
        validUntil: '2099-03-23T00:00:00.000Z',
        confidence: 0.8,
      },
    },
  ], []);

  assert.equal(recovered.openLoops.length, 0);
  assert.equal(recovered.resolvedOpenLoops.length, 1);
  assert.match(recovered.resolvedOpenLoops[0] ?? '', /sqlite storage follow-up/i);
});

test('materializeTaskState drops resolved history once a related loop is reopened', () => {
  const recovered = materializeTaskState('reopened-summary-loop-session', [
    {
      id: 'summary:1',
      kind: 'summary',
      sessionId: 'reopened-summary-loop-session',
      createdAt: '2099-03-22T00:00:00.000Z',
      tags: ['summary'],
      payload: {
        summaryId: 'summary:1',
        branchRoot: 'u1',
        intent: 'finish the MVP',
        constraints: [],
        finalDecisions: [],
        candidateDecisions: [],
        toolFacts: [],
        evidenceRefs: [],
        artifactFinalState: [],
        openLoopsRemaining: ['SQLite fixture coverage follow up is still pending for the branching demo later.'],
        resolvedOpenLoops: ['Finished the SQLite fixture coverage follow-up and closed that loop.'],
        validUntil: '2099-03-23T00:00:00.000Z',
        confidence: 0.8,
      },
    },
  ], []);

  assert.equal(recovered.openLoops.length, 1);
  assert.match(recovered.openLoops[0] ?? '', /sqlite fixture coverage/i);
  assert.equal(recovered.resolvedOpenLoops.length, 0);
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

test('engine keeps layered memory transient even when assembling from a SQLite-backed session', async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'openclaw-memory-repo-'));
  const store = new SQLiteStore(':memory:');
  const writer = new HypergraphContextEngine({
    sessionStore: store,
    memoryWorkspaceRoot: workspaceRoot,
    enableLayeredRead: true,
    enableLayeredWrite: true,
    flushOnAfterTurn: false,
    flushOnCompact: false,
  });

  await writer.ingestMany(toySessionId, toyTranscript);
  await writer.flushMemory(toySessionId, 'manual_save');

  const persisted = store.loadSession(toySessionId);
  assert.equal(persisted?.nodes.some((node) => node.kind === 'memory_chunk'), false);

  const reader = new HypergraphContextEngine({
    sessionStore: store,
    memoryWorkspaceRoot: workspaceRoot,
    enableLayeredRead: true,
    enableLayeredWrite: false,
  });
  const assembled = await reader.assemble({
    sessionId: toySessionId,
    currentTurnText: 'recover layered memory without persisting workspace chunks per session',
    tokenBudget: 400,
  });

  assert.ok(assembled.retrievalSummary?.some((candidate) => candidate.layer === 'hot' || candidate.layer === 'warm'));

  const reloaded = store.loadSession(toySessionId);
  assert.equal(reloaded?.nodes.some((node) => node.kind === 'memory_chunk'), false);
  store.close();
});

test('assemble expands selected summary nodes with referenced evidence nodes after compaction', async () => {
  const engine = new HypergraphContextEngine();
  await engine.ingestMany(toySessionId, toyTranscript);
  await engine.compact(toySessionId);

  const assembled = await engine.assemble({
    sessionId: toySessionId,
    currentTurnText: 'summarize the compacted sqlite follow-up evidence',
    tokenBudget: 320,
  });

  const summaryMessage = assembled.messages.find((message) => message.kind === 'summary');
  assert.ok(summaryMessage);
  assert.ok(
    assembled.messages.some((message) => message.id === 'a2:decision' || message.id === 't1:tool-result'),
    'selected summary nodes should pull referenced evidence into assembled messages',
  );
  assert.ok(
    assembled.messages.some((message) => message.kind === 'open_loop' || message.kind === 'artifact_snapshot'),
    'summary evidence expansion should also retain task-state evidence like open loops or artifact snapshots',
  );
});

test('compact summaries keep branching follow-up evidence refs for post-compact assemble', async () => {
  const engine = new HypergraphContextEngine();
  await engine.ingestMany(branchingSessionId, branchingTranscript);
  const compacted = await engine.compact(branchingSessionId);

  const snapshot = engine.debugSession(branchingSessionId);
  const summaryNode = snapshot?.nodes.find((node) => node.id === compacted.summaryNodeId);
  const payload = summaryNode?.payload as {
    evidenceRefs?: string[];
  };

  assert.ok(payload.evidenceRefs?.some((id) => id.endsWith(':open-loop')));
  assert.ok(payload.evidenceRefs?.some((id) => id.endsWith(':artifact')));

  const reassembled = await engine.assemble({
    sessionId: branchingSessionId,
    currentTurnText: 'keep the branching regression follow-up visible after compaction',
    tokenBudget: 320,
  });

  assert.ok(reassembled.messages.some((message) => message.kind === 'open_loop' || message.kind === 'artifact_snapshot'));
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

test('materializeTaskState prefers tool-scoped fact strings over duplicate raw tool-result summaries', () => {
  const nodes = toyTranscript.flatMap((entry) => extractNodes(toySessionId, entry));
  const state = materializeTaskState(toySessionId, nodes);

  assert.ok(state.toolFacts.includes('read: ARCHITECTURE.md confirms transcript tree remains source of truth and assemble should degrade gracefully.'));
  assert.equal(state.toolFacts.filter((value) => value.includes('ARCHITECTURE.md confirms')).length, 1);
});

test('materializeTaskState excludes superseded decisions from activeDecisions', () => {
  const sessionId = 'superseded-decision-session';
  const nodes = [
    ...extractNodes(sessionId, {
      id: 'a1',
      role: 'assistant',
      content: 'I will implement the first retrieval heuristic now.',
      createdAt: '2026-03-22T01:00:00.000Z',
    }),
    ...extractNodes(sessionId, {
      id: 'a2',
      role: 'assistant',
      content: 'I will implement a smaller retrieval heuristic instead.',
      createdAt: '2026-03-22T01:01:00.000Z',
    }),
  ];
  const state = materializeTaskState(sessionId, nodes, [
    {
      id: 'a2:decision->a1:decision',
      kind: 'supersedes',
      from: 'a2:decision',
      to: 'a1:decision',
      createdAt: '2026-03-22T01:01:00.000Z',
      reason: 'newer decision replaces earlier plan',
    },
  ]);

  assert.ok(state.activeDecisions.some((value) => value.includes('smaller retrieval heuristic')));
  assert.equal(state.activeDecisions.some((value) => value.includes('first retrieval heuristic now')), false);
});

test('materializeTaskState derives an ordered priority backlog from user priority lists', () => {
  const sessionId = 'priority-backlog-session';
  const nodes = [
    ...extractNodes(sessionId, {
      id: 'u1',
      role: 'user',
      type: 'message',
      createdAt: '2026-03-22T12:00:00.000Z',
      content: '检查 Hypergraph Context Engine 项目当前进展，直接继续推进实现。优先顺序固定为：1) task-state 2) ingest 3) assemble 4) toy demo/fixtures 5) compact 最小版 6) commit + push 到 GitHub。',
    }),
    ...extractNodes(sessionId, {
      id: 'a1',
      role: 'assistant',
      type: 'message',
      createdAt: '2026-03-22T12:05:00.000Z',
      content: 'Implemented task-state backlog recovery for numbered priority lists.',
    }),
  ];

  const state = materializeTaskState(sessionId, nodes, []);

  assert.deepEqual(state.priorityBacklog, [
    'Priority backlog: ingest',
    'Priority backlog: assemble',
    'Priority backlog: toy demo/fixtures',
    'Priority backlog: compact 最小版',
    'Priority backlog: commit + push 到 GitHub',
  ]);
  assert.deepEqual(
    state.priorityStatus.map((item) => [item.item, item.status]),
    [
      ['task-state', 'active'],
      ['ingest', 'pending'],
      ['assemble', 'pending'],
      ['toy demo/fixtures', 'pending'],
      ['compact 最小版', 'pending'],
      ['commit + push 到 GitHub', 'pending'],
    ],
  );
  assert.deepEqual(state.openLoops, []);
});

test('materializeTaskState drops priority backlog items once they are covered elsewhere in state', () => {
  const sessionId = 'priority-backlog-covered-session';
  const nodes = [
    ...extractNodes(sessionId, {
      id: 'u1',
      role: 'user',
      type: 'message',
      createdAt: '2026-03-22T12:00:00.000Z',
      content: 'Priority: 1) task-state 2) ingest 3) assemble',
    }),
    ...extractNodes(sessionId, {
      id: 'a1',
      role: 'assistant',
      type: 'message',
      createdAt: '2026-03-22T12:01:00.000Z',
      content: 'I will implement ingest next.',
    }),
    ...extractNodes(sessionId, {
      id: 'u2',
      role: 'user',
      type: 'message',
      createdAt: '2026-03-22T12:02:00.000Z',
      content: 'Could you keep assemble later?',
    }),
  ];

  const state = materializeTaskState(sessionId, nodes, []);

  assert.deepEqual(state.priorityBacklog, ['Priority backlog: task-state']);
  assert.deepEqual(
    state.priorityStatus.map((item) => [item.item, item.status]),
    [
      ['task-state', 'pending'],
      ['ingest', 'active'],
      ['assemble', 'open_loop'],
    ],
  );
  assert.deepEqual(state.openLoops, ['Could you keep assemble later?']);
});

test('materializeTaskState prefers open_loop over active when a priority item is both in progress and still blocked', () => {
  const sessionId = 'priority-open-loop-over-active-session';
  const nodes = [
    ...extractNodes(sessionId, {
      id: 'u1',
      role: 'user',
      type: 'message',
      createdAt: '2026-03-22T12:00:00.000Z',
      content: 'Priority: 1) assemble 2) ingest',
    }),
    ...extractNodes(sessionId, {
      id: 'a1',
      role: 'assistant',
      type: 'message',
      createdAt: '2026-03-22T12:01:00.000Z',
      content: 'I will assemble the compact context buckets next.',
    }),
    ...extractNodes(sessionId, {
      id: 'a2',
      role: 'assistant',
      type: 'message',
      createdAt: '2026-03-22T12:02:00.000Z',
      content: 'Added retrieval scoring and bucket seeding. Next step: wire assemble output into the toy demo fixture.',
    }),
  ];

  const state = materializeTaskState(sessionId, nodes, []);

  assert.deepEqual(
    state.priorityStatus.map((item) => [item.item, item.status]),
    [
      ['assemble', 'open_loop'],
      ['ingest', 'pending'],
    ],
  );
  assert.ok(state.openLoops.some((value) => /assemble output into the toy demo fixture/i.test(value)));
});

test('materializeTaskState treats artifact-backed priority progress as resolved even if wording varies', () => {
  const sessionId = 'priority-backlog-task-state-alias-session';
  const nodes = [
    ...extractNodes(sessionId, {
      id: 'u1',
      role: 'user',
      type: 'message',
      createdAt: '2026-03-22T12:00:00.000Z',
      content: 'Priority: 1) task-state 2) ingest 3) toy demo/fixtures 4) commit + push 到 GitHub',
    }),
    ...extractNodes(sessionId, {
      id: 'a1',
      role: 'assistant',
      type: 'message',
      createdAt: '2026-03-22T12:01:00.000Z',
      content: 'Implemented task state materialization, stabilized the demo fixtures, and committed + pushed the branch to GitHub.',
    }),
  ];

  const state = materializeTaskState(sessionId, nodes, []);

  assert.deepEqual(state.priorityBacklog, ['Priority backlog: ingest']);
  assert.deepEqual(
    state.priorityStatus.map((item) => [item.item, item.status]),
    [
      ['task-state', 'resolved'],
      ['ingest', 'pending'],
      ['toy demo/fixtures', 'resolved'],
      ['commit + push 到 GitHub', 'resolved'],
    ],
  );
  assert.deepEqual(state.openLoops, []);
});

test('materializeTaskState treats tool-result-only progress as resolved priority coverage when completion cues exist', () => {
  const sessionId = 'priority-tool-result-resolution-session';
  const nodes = [
    ...extractNodes(sessionId, {
      id: 'u1',
      role: 'user',
      type: 'message',
      createdAt: '2026-03-22T12:00:00.000Z',
      content: 'Priority: 1) toy demo/fixtures 2) compact 最小版 3) commit + push 到 GitHub',
    }),
    ...extractNodes(sessionId, {
      id: 'tr-demo',
      role: 'tool',
      type: 'tool_result',
      createdAt: '2026-03-22T12:01:00.000Z',
      content: 'npm run demo:snapshots\n=== SCENARIO: toy-session ===',
    }),
    ...extractNodes(sessionId, {
      id: 'tr-compact',
      role: 'tool',
      type: 'tool_result',
      createdAt: '2026-03-22T12:02:00.000Z',
      content: 'summary created for toy-session\nopen loops kept: 2\npruned 3 older raw nodes',
    }),
    ...extractNodes(sessionId, {
      id: 'tr-push',
      role: 'tool',
      type: 'tool_result',
      createdAt: '2026-03-22T12:03:00.000Z',
      content: 'To github.com:example/hypergraph-context-engine.git\n   1234567..89abcde  master -> master',
    }),
  ];

  const state = materializeTaskState(sessionId, nodes, []);

  assert.deepEqual(state.priorityBacklog, []);
  assert.deepEqual(
    state.priorityStatus.map((item) => [item.item, item.status]),
    [
      ['toy demo/fixtures', 'resolved'],
      ['compact 最小版', 'resolved'],
      ['commit + push 到 GitHub', 'resolved'],
    ],
  );
});

test('materializeTaskState prefers the latest explicit priority list over stale earlier ordering', () => {
  const sessionId = 'priority-backlog-latest-list-session';
  const nodes = [
    ...extractNodes(sessionId, {
      id: 'u1',
      role: 'user',
      type: 'message',
      createdAt: '2026-03-22T12:00:00.000Z',
      content: 'Priority: 1) task-state 2) ingest 3) assemble 4) compact',
    }),
    ...extractNodes(sessionId, {
      id: 'u2',
      role: 'user',
      type: 'message',
      createdAt: '2026-03-22T12:03:00.000Z',
      content: 'Updated priority order: 1) assemble 2) toy demo/fixtures 3) commit + push 到 GitHub',
    }),
  ];

  const state = materializeTaskState(sessionId, nodes, []);

  assert.deepEqual(state.priorityBacklog, [
    'Priority backlog: assemble',
    'Priority backlog: toy demo/fixtures',
    'Priority backlog: commit + push 到 GitHub',
  ]);
  assert.deepEqual(
    state.priorityStatus.map((item) => [item.item, item.status]),
    [
      ['assemble', 'pending'],
      ['toy demo/fixtures', 'pending'],
      ['commit + push 到 GitHub', 'pending'],
    ],
  );
});

test('materializeTaskState trims trailing constraint sentences off priority items', () => {
  const sessionId = 'priority-backlog-trailing-constraint-session';
  const nodes = [
    ...extractNodes(sessionId, {
      id: 'u1',
      role: 'user',
      type: 'message',
      createdAt: '2026-03-22T12:00:00.000Z',
      content: 'Priority: 1) task-state 2) ingest 3) assemble. Please keep the transcript as source of truth.',
    }),
  ];

  const state = materializeTaskState(sessionId, nodes, []);

  assert.deepEqual(state.priorityBacklog, [
    'Priority backlog: task-state',
    'Priority backlog: ingest',
    'Priority backlog: assemble',
  ]);
  assert.deepEqual(
    state.priorityStatus.map((item) => [item.item, item.status]),
    [
      ['task-state', 'pending'],
      ['ingest', 'pending'],
      ['assemble', 'pending'],
    ],
  );
});

test('demo scenarios produce stable compact snapshots for fixtures and regressions', async () => {
  const snapshots = await runAllDemoScenarios();

  assert.equal(snapshots.length, 2);

  const toySnapshot = snapshots.find((snapshot) => snapshot.sessionId === toySessionId);
  assert.ok(toySnapshot);
  assert.match(toySnapshot?.assembled.taskState.intent ?? '', /Hypergraph Context Engine MVP/i);
  assert.ok(toySnapshot?.assembled.taskState.openLoops.some((value) => /sqlite storage later/i.test(value)));
  assert.ok(toySnapshot?.compact.summary.openLoopsRemaining.some((value) => /heuristic retrieval/i.test(value)));
  assert.ok((toySnapshot?.edgeKinds.responds_to ?? 0) >= 3);
  assert.deepEqual(toySnapshot?.storedSessionIds, [toySessionId]);

  const branchingSnapshot = snapshots.find((snapshot) => snapshot.sessionId === branchingSessionId);
  assert.ok(branchingSnapshot);
  assert.ok(branchingSnapshot?.assembled.taskState.resolvedOpenLoops.some((value) => /golden regression snapshots later/i.test(value)));
  assert.ok(branchingSnapshot?.reassembledAfterCompact.messageKinds.includes('summary'));
  assert.ok((branchingSnapshot?.edgeKinds.resolves ?? 0) >= 1);
  assert.deepEqual(branchingSnapshot?.storedSessionIds, [branchingSessionId]);
});
