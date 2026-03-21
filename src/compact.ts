import type { BaseNode, SummaryNodePayload } from '../schemas/types.js';
import type { SessionSnapshot } from './ingest.js';
import { materializeTaskState } from './task-state.js';

export interface CompactComputation {
  summaryNode: BaseNode;
  notes: string[];
}

export function compactSession(snapshot: SessionSnapshot): CompactComputation {
  const taskState = materializeTaskState(snapshot.sessionId, snapshot.nodes, snapshot.edges);
  const createdAt = new Date().toISOString();
  const evidenceRefs = snapshot.nodes
    .filter((node) => node.kind === 'tool_result' || node.kind === 'decision' || node.kind === 'constraint')
    .map((node) => node.id)
    .slice(-8);

  const payload: SummaryNodePayload = {
    summaryId: `${snapshot.sessionId}:summary:${Date.now()}`,
    branchRoot: snapshot.transcriptEntries[0]?.id ?? snapshot.sessionId,
    intent: taskState.intent,
    constraints: taskState.constraints,
    finalDecisions: taskState.activeDecisions,
    evidenceRefs,
    artifactFinalState: taskState.artifactState,
    openLoopsRemaining: uniqueLimited([
      ...taskState.openLoops,
      'Future work: replace in-memory session state with SQLite-backed storage.',
    ]),
    resolvedOpenLoops: taskState.resolvedOpenLoops,
    confidence: taskState.confidence,
  };

  const summaryNode: BaseNode = {
    id: payload.summaryId,
    kind: 'summary',
    sessionId: snapshot.sessionId,
    createdAt,
    tags: ['summary', 'compact'],
    payload: payload as unknown as Record<string, unknown>,
  };

  return {
    summaryNode,
    notes: [
      `summary created for ${snapshot.sessionId}`,
      `captured ${payload.finalDecisions.length} active decisions`,
      `open loops kept: ${payload.openLoopsRemaining.length}`,
    ],
  };
}

function uniqueLimited(values: string[], limit = 8): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    out.push(normalized);

    if (out.length >= limit) {
      break;
    }
  }

  return out;
}
