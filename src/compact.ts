import type { BaseNode, GraphEdge, SummaryNodePayload } from '../schemas/types.js';
import type { SessionSnapshot } from './ingest.js';
import { materializeTaskState } from './task-state.js';

export interface CompactOptions {
  keepLastTranscriptEntries?: number;
  keepLastRawNodes?: number;
  keepSummaryNodes?: number;
}

export interface CompactComputation {
  summaryNode: BaseNode;
  notes: string[];
  compactedSnapshot: SessionSnapshot;
}

const DEFAULT_OPTIONS: Required<CompactOptions> = {
  keepLastTranscriptEntries: 6,
  keepLastRawNodes: 12,
  keepSummaryNodes: 2,
};

export function compactSession(snapshot: SessionSnapshot, options: CompactOptions = {}): CompactComputation {
  const taskState = materializeTaskState(snapshot.sessionId, snapshot.nodes, snapshot.edges);
  const createdAt = new Date().toISOString();
  const evidenceRefs = snapshot.nodes
    .filter((node) => isSummaryEvidenceNode(node.kind))
    .map((node) => node.id)
    .slice(-10);

  const payload: SummaryNodePayload = {
    summaryId: `${snapshot.sessionId}:summary:${Date.now()}`,
    branchRoot: snapshot.transcriptEntries[0]?.id ?? snapshot.sessionId,
    intent: taskState.intent,
    constraints: taskState.constraints,
    finalDecisions: taskState.activeDecisions,
    candidateDecisions: taskState.candidateDecisions,
    toolFacts: taskState.toolFacts,
    evidenceRefs,
    artifactFinalState: taskState.artifactState,
    priorityBacklog: taskState.priorityBacklog,
    priorityStatus: taskState.priorityStatus.map((item) => ({
      ...item,
      source: 'summary' as const,
    })),
    openLoopsRemaining: uniqueLimited([
      ...taskState.openLoops,
      deriveCompactFollowUp(taskState),
    ]),
    resolvedOpenLoops: taskState.resolvedOpenLoops,
    validUntil: new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString(),
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

  const compactedSnapshot = pruneSnapshot(
    {
      ...snapshot,
      nodes: [...snapshot.nodes, summaryNode],
    },
    {
      ...DEFAULT_OPTIONS,
      ...options,
    },
  );

  const prunedNodeCount = snapshot.nodes.length + 1 - compactedSnapshot.nodes.length;
  const prunedTranscriptCount = snapshot.transcriptEntries.length - compactedSnapshot.transcriptEntries.length;

  return {
    summaryNode,
    compactedSnapshot,
    notes: [
      `summary created for ${snapshot.sessionId}`,
      `captured ${payload.finalDecisions.length} active decisions`,
      `open loops kept: ${payload.openLoopsRemaining.length}`,
      prunedNodeCount > 0 ? `pruned ${prunedNodeCount} older raw nodes` : 'raw nodes already within compact budget',
      prunedTranscriptCount > 0 ? `trimmed ${prunedTranscriptCount} older transcript entries` : 'transcript already within compact budget',
    ],
  };
}

function deriveCompactFollowUp(taskState: ReturnType<typeof materializeTaskState>): string {
  const knownOpenLoops = [...taskState.openLoops, ...taskState.resolvedOpenLoops].join(' ').toLowerCase();

  if (!knownOpenLoops.includes('retriev')) {
    return 'Future work: replace heuristic retrieval with lexical / embedding retrieval.';
  }

  if (!knownOpenLoops.includes('hyperedge')) {
    return 'Future work: promote heuristic relation edges into richer hyperedges.';
  }

  return 'Future work: make compaction branch-aware instead of using a fixed retention budget.';
}

function pruneSnapshot(snapshot: SessionSnapshot, options: Required<CompactOptions>): SessionSnapshot {
  const keptTranscriptEntries = snapshot.transcriptEntries.slice(-options.keepLastTranscriptEntries);
  const keptTranscriptIds = new Set(keptTranscriptEntries.map((entry) => entry.id));

  const summaryNodes = snapshot.nodes.filter((node) => node.kind === 'summary').slice(-options.keepSummaryNodes);
  const rawNodes = snapshot.nodes.filter((node) => isRawNode(node.kind));
  const semanticNodes = snapshot.nodes.filter((node) => !isRawNode(node.kind) && node.kind !== 'summary');
  const keptRawNodes = rawNodes.filter((node) => keptTranscriptIds.has(node.transcriptId ?? '')).slice(-options.keepLastRawNodes);

  const retainedNodeMap = new Map<string, BaseNode>();
  for (const node of [...semanticNodes, ...keptRawNodes, ...summaryNodes]) {
    retainedNodeMap.set(node.id, node);
  }

  const keptNodes = [...retainedNodeMap.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const keptNodeIds = new Set(keptNodes.map((node) => node.id));
  const keptEdges = snapshot.edges.filter((edge) => keptNodeIds.has(edge.from) && keptNodeIds.has(edge.to));

  return {
    ...snapshot,
    transcriptEntries: keptTranscriptEntries,
    nodes: keptNodes,
    edges: keptEdges,
  };
}

function isSummaryEvidenceNode(kind: BaseNode['kind']): boolean {
  return kind === 'intent'
    || kind === 'constraint'
    || kind === 'decision'
    || kind === 'tool_result'
    || kind === 'artifact_snapshot'
    || kind === 'open_loop';
}

function isRawNode(kind: BaseNode['kind']): boolean {
  return kind === 'message' || kind === 'tool_call' || kind === 'tool_result';
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
