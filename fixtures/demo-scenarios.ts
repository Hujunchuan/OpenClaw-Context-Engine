import type { SummaryNodePayload } from '../schemas/types.js';
import { HypergraphContextEngine } from '../src/core/engine.js';
import type { TranscriptEntryLike } from '../src/core/engine.js';
import { SQLiteStore } from '../src/core/sqlite-store.js';
import { branchingSessionId, branchingTranscript } from './branching-transcript.js';
import { toySessionId, toyTranscript } from './toy-transcript.js';

export interface DemoScenarioDefinition {
  sessionId: string;
  transcript: TranscriptEntryLike[];
  currentTurnText: string;
}

export interface DemoScenarioSnapshot {
  sessionId: string;
  assembled: {
    messageKinds: string[];
    taskState: {
      intent: string | null | undefined;
      constraints: string[];
      activeDecisions: string[];
      priorityBacklog: string[];
      priorityStatus: Array<{ item: string; status: string }>;
      openLoops: string[];
      resolvedOpenLoops: string[];
      artifactState: string[];
    };
    bucketSummary: Array<{ name: string; count: number; budgetTokens: number }>;
    retrievalSummary: Array<{
      nodeId: string;
      kind?: string;
      bucket?: string;
      selected: boolean;
      finalScore: number;
    }>;
  };
  compact: {
    notes: string[];
    summary: {
      intent?: string | null;
      constraints: string[];
      finalDecisions: string[];
      candidateDecisions: string[];
      toolFacts: string[];
      artifactFinalState: string[];
      priorityBacklog: string[];
      priorityStatus: Array<{ item: string; status: string }>;
      openLoopsRemaining: string[];
      resolvedOpenLoops: string[];
      confidence?: number;
    };
  };
  reassembledAfterCompact: {
    messageKinds: string[];
    bucketSummary: Array<{ name: string; count: number; budgetTokens: number }>;
    retrievalSummary: Array<{
      nodeId: string;
      kind?: string;
      bucket?: string;
      selected: boolean;
      finalScore: number;
    }>;
  };
  edgeKinds: Record<string, number>;
  storedSessionIds: string[];
}

export const demoScenarioDefinitions: DemoScenarioDefinition[] = [
  {
    sessionId: toySessionId,
    transcript: toyTranscript,
    currentTurnText: 'implement assemble and capture the sqlite next step',
  },
  {
    sessionId: branchingSessionId,
    transcript: branchingTranscript,
    currentTurnText: 'update the toy transcript demo and keep the golden fixture follow-up visible',
  },
];

export async function runDemoScenario(definition: DemoScenarioDefinition): Promise<DemoScenarioSnapshot> {
  const store = new SQLiteStore(':memory:');
  const engine = new HypergraphContextEngine({ store });

  const assembled = await engine.ingestAndAssemble(definition.sessionId, definition.transcript, {
    currentTurnText: definition.currentTurnText,
    tokenBudget: 500,
  });

  const compacted = await engine.compact(definition.sessionId);
  const reassembledAfterCompact = await engine.assemble({
    sessionId: definition.sessionId,
    currentTurnText: definition.currentTurnText,
    tokenBudget: 320,
  });

  const debugSession = engine.debugSession(definition.sessionId);
  const summaryNode = debugSession?.nodes.find((node) => node.id === compacted.summaryNodeId);
  const summaryPayload = (summaryNode?.payload ?? {}) as Partial<SummaryNodePayload>;
  const edgeKinds = summarizeEdgeKinds(debugSession?.edges ?? []);
  const snapshot: DemoScenarioSnapshot = {
    sessionId: definition.sessionId,
    assembled: {
      messageKinds: (assembled.messages ?? []).map((message) => String(message.kind ?? 'unknown')),
      taskState: {
        intent: assembled.taskState?.intent,
        constraints: assembled.taskState?.constraints ?? [],
        activeDecisions: assembled.taskState?.activeDecisions ?? [],
        priorityBacklog: assembled.taskState?.priorityBacklog ?? [],
        priorityStatus: (assembled.taskState?.priorityStatus ?? []).map((item) => ({ item: item.item, status: item.status })),
        openLoops: assembled.taskState?.openLoops ?? [],
        resolvedOpenLoops: assembled.taskState?.resolvedOpenLoops ?? [],
        artifactState: assembled.taskState?.artifactState ?? [],
      },
      bucketSummary: assembled.bucketSummary ?? [],
      retrievalSummary: normalizeRetrievalSummary(assembled.retrievalSummary ?? []),
    },
    compact: {
      notes: compacted.notes ?? [],
      summary: {
        intent: summaryPayload.intent,
        constraints: summaryPayload.constraints ?? [],
        finalDecisions: summaryPayload.finalDecisions ?? [],
        candidateDecisions: summaryPayload.candidateDecisions ?? [],
        toolFacts: summaryPayload.toolFacts ?? [],
        artifactFinalState: summaryPayload.artifactFinalState ?? [],
        priorityBacklog: summaryPayload.priorityBacklog ?? [],
        priorityStatus: (summaryPayload.priorityStatus ?? []).map((item) => ({ item: item.item, status: item.status })),
        openLoopsRemaining: summaryPayload.openLoopsRemaining ?? [],
        resolvedOpenLoops: summaryPayload.resolvedOpenLoops ?? [],
        confidence: summaryPayload.confidence,
      },
    },
    reassembledAfterCompact: {
      messageKinds: (reassembledAfterCompact.messages ?? []).map((message) => String(message.kind ?? 'unknown')),
      bucketSummary: reassembledAfterCompact.bucketSummary ?? [],
      retrievalSummary: normalizeRetrievalSummary(reassembledAfterCompact.retrievalSummary ?? []),
    },
    edgeKinds,
    storedSessionIds: store.listSessionIds(),
  };

  store.close();
  return snapshot;
}

export async function runAllDemoScenarios(): Promise<DemoScenarioSnapshot[]> {
  const snapshots: DemoScenarioSnapshot[] = [];

  for (const definition of demoScenarioDefinitions) {
    snapshots.push(await runDemoScenario(definition));
  }

  return snapshots;
}

function normalizeRetrievalSummary(
  candidates: Array<{
    nodeId: string;
    kind?: string;
    bucket?: string;
    selected: boolean;
    finalScore: number;
  }>,
): Array<{
  nodeId: string;
  kind?: string;
  bucket?: string;
  selected: boolean;
  finalScore: number;
}> {
  return candidates.map((candidate) => ({
    nodeId: normalizeSummaryNodeId(candidate.nodeId),
    kind: candidate.kind,
    bucket: candidate.bucket,
    selected: candidate.selected,
    finalScore: candidate.finalScore,
  }));
}

function normalizeSummaryNodeId(nodeId: string): string {
  return nodeId.replace(/:summary:\d+$/, ':summary:<stable>');
}

function summarizeEdgeKinds(edges: Array<{ kind: string }>): Record<string, number> {
  return edges.reduce<Record<string, number>>((counts, edge) => {
    counts[edge.kind] = (counts[edge.kind] ?? 0) + 1;
    return counts;
  }, {});
}
