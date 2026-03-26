import type {
  BaseNode,
  GraphEdge,
  MemoryChunkPayload,
  MemoryNamespaceContext,
  RetrievalCandidate,
  TaskState,
} from '../../schemas/types.js';
import {
  looksLikeConversationRecall,
  looksLikeDetailSeekingQuery,
  looksLikeTaskContinuationQuery,
} from './dialogue-cues.js';

export interface RetrieveInput {
  nodes: BaseNode[];
  edges?: GraphEdge[];
  taskState: TaskState;
  currentTurnText?: string;
  limit?: number;
  memoryNamespace?: MemoryNamespaceContext;
}

export interface RetrieveOutput {
  candidates: RetrievalCandidate[];
  selectedNodeIds: string[];
}

type MemoryQueryMode = 'default' | 'conversation_recall' | 'task_continuation';

export function retrieveRelevantNodes(input: RetrieveInput): RetrieveOutput {
  const scored = scoreCandidates(
    input.nodes,
    input.taskState,
    input.currentTurnText,
    input.edges ?? [],
    input.memoryNamespace,
  );
  const limit = Math.max(1, input.limit ?? Math.min(12, input.nodes.length));

  return {
    candidates: scored,
    selectedNodeIds: scored.slice(0, limit).map((candidate) => candidate.nodeId),
  };
}

export function scoreCandidates(
  nodes: BaseNode[],
  taskState: TaskState,
  currentTurnText?: string,
  edges: GraphEdge[] = [],
  memoryNamespace?: MemoryNamespaceContext,
): RetrievalCandidate[] {
  const currentText = (currentTurnText ?? '').toLowerCase();
  const edgeIndex = buildEdgeIndex(edges);
  const queryMode = classifyMemoryQueryMode(currentTurnText);

  return nodes
    .map((node, index) => {
      const text = JSON.stringify(node.payload).toLowerCase();
      const graphScore = graphAffinity(node, taskState, edgeIndex);
      const retrievalScore = currentText && text.includes(currentText) ? 1 : keywordOverlap(currentText, text);
      const recencyScore = Math.max(0.1, (index + 1) / Math.max(nodes.length, 1));
      const utilityScore = utility(node.kind);
      const redundancyPenalty = index > 0 && nodes[index - 1]?.kind === node.kind ? 0.15 : 0;
      const layerWeight = resolveLayerWeight(node);
      const namespaceWeight = resolveNamespaceWeight(node, memoryNamespace, queryMode);
      const detailWeight = resolveDetailWeight(node, currentTurnText, queryMode);
      const finalScore = Number(
        ((0.35 * graphScore + 0.25 * retrievalScore + 0.2 * recencyScore + 0.2 * utilityScore) * layerWeight * namespaceWeight * detailWeight - redundancyPenalty).toFixed(3),
      );

      return {
        nodeId: node.id,
        graphScore,
        retrievalScore,
        recencyScore,
        utilityScore,
        redundancyPenalty,
        finalScore,
      };
    })
    .sort((a, b) => b.finalScore - a.finalScore);
}

function resolveLayerWeight(node: BaseNode): number {
  if (node.kind !== 'memory_chunk') {
    return 0.35;
  }

  const payload = node.payload as Partial<MemoryChunkPayload> | undefined;
  switch (payload?.layer) {
    case 'hot':
      return 1;
    case 'warm':
      return 0.82;
    case 'cold':
      return 0.65;
    case 'daily_log':
      return 0.45;
    case 'archive':
      return 0.2;
    case 'memory_core':
      return 0.65;
    default:
      return 0.35;
  }
}

function resolveNamespaceWeight(
  node: BaseNode,
  namespace: MemoryNamespaceContext | undefined,
  queryMode: MemoryQueryMode,
): number {
  if (node.kind !== 'memory_chunk') {
    return 1;
  }

  if (!namespace) {
    return 1;
  }

  const payload = node.payload as Partial<MemoryChunkPayload> | undefined;
  const layer = payload?.layer;
  const sessionMatch = Boolean(namespace?.sessionId && payload?.lastSessionId === namespace.sessionId);
  const agentMatch = Boolean(namespace?.agentId && payload?.lastAgentId === namespace.agentId);
  const workspaceMatch = Boolean(namespace?.workspaceId && payload?.lastWorkspaceId === namespace.workspaceId);

  if (sessionMatch) {
    return 1.45;
  }

  if (agentMatch) {
    return 1.3;
  }

  if (workspaceMatch) {
    return 1.1;
  }

  if (queryMode === 'conversation_recall') {
    switch (layer) {
      case 'cold':
      case 'memory_core':
        return 0.55;
      case 'warm':
        return 0.3;
      case 'hot':
      case 'daily_log':
        return 0.2;
      case 'archive':
        return 0.1;
      default:
        return 0.35;
    }
  }

  if (queryMode === 'task_continuation') {
    switch (layer) {
      case 'cold':
      case 'memory_core':
        return 0.7;
      case 'warm':
        return 0.45;
      case 'hot':
      case 'daily_log':
        return 0.25;
      case 'archive':
        return 0.12;
      default:
        return 0.4;
    }
  }

  switch (layer) {
    case 'cold':
    case 'memory_core':
      return 0.82;
    case 'warm':
      return 0.62;
    case 'hot':
      return 0.48;
    case 'daily_log':
      return 0.35;
    case 'archive':
      return 0.18;
    default:
      return 0.5;
  }
}

function resolveDetailWeight(
  node: BaseNode,
  currentTurnText: string | undefined,
  queryMode: MemoryQueryMode,
): number {
  if (node.kind !== 'memory_chunk') {
    return 1;
  }

  const payload = node.payload as Partial<MemoryChunkPayload> | undefined;
  const level = payload?.selectedDetailLevel;

  if (!level) {
    return 1;
  }

  if (queryMode === 'conversation_recall' || queryMode === 'task_continuation') {
    switch (level) {
      case 'L0':
        return 1.15;
      case 'L1':
        return 1.05;
      case 'L2':
        return 0.72;
      default:
        return 1;
    }
  }

  if (looksLikeDetailSeekingQuery(currentTurnText)) {
    switch (level) {
      case 'L2':
        return 1.18;
      case 'L1':
        return 1.08;
      case 'L0':
        return 0.94;
      default:
        return 1;
    }
  }

  switch (level) {
    case 'L0':
      return 1.12;
    case 'L1':
      return 1.06;
    case 'L2':
      return 0.84;
    default:
      return 1;
  }
}

function graphAffinity(node: BaseNode, taskState: TaskState, edgeIndex: Map<string, GraphEdge[]>): number {
  const text = JSON.stringify(node.payload).toLowerCase();
  const probes = [
    taskState.intent,
    ...taskState.constraints,
    ...taskState.activeDecisions,
    ...taskState.priorityStatus.map((item) => item.item),
    ...taskState.priorityBacklog,
    ...taskState.openLoops,
    ...taskState.artifactState,
  ]
    .filter(Boolean)
    .map((item) => String(item).toLowerCase());

  const directHits = probes.filter((probe) => text.includes(probe)).length;
  const baseScore = probes.length === 0
    ? node.kind === 'message'
      ? 0.3
      : 0.5
    : Math.min(1, directHits / Math.max(1, probes.length / 2));

  const relationBoost = edgeRelationBoost(node, edgeIndex);
  return Math.min(1, Number((baseScore + relationBoost).toFixed(3)));
}

function classifyMemoryQueryMode(currentTurnText?: string): MemoryQueryMode {
  const text = currentTurnText ?? '';
  if (looksLikeConversationRecall(text)) {
    return 'conversation_recall';
  }

  if (looksLikeTaskContinuationQuery(text)) {
    return 'task_continuation';
  }

  return 'default';
}

function edgeRelationBoost(node: BaseNode, edgeIndex: Map<string, GraphEdge[]>): number {
  const relatedEdges = edgeIndex.get(node.id) ?? [];
  let boost = 0;

  for (const edge of relatedEdges) {
    switch (edge.kind) {
      case 'resolves':
        boost += node.kind === 'decision' ? 0.35 : 0.2;
        break;
      case 'depends_on':
        boost += node.kind === 'artifact_snapshot' || node.kind === 'tool_result' ? 0.22 : 0.12;
        break;
      case 'supersedes':
        boost += 0.15;
        break;
      case 'derived_from':
        boost += 0.05;
        break;
      default:
        boost += 0;
    }
  }

  return Math.min(0.45, boost);
}

function buildEdgeIndex(edges: GraphEdge[]): Map<string, GraphEdge[]> {
  const index = new Map<string, GraphEdge[]>();

  for (const edge of edges) {
    const bucket = index.get(edge.from) ?? [];
    bucket.push(edge);
    index.set(edge.from, bucket);
  }

  return index;
}

function keywordOverlap(currentText: string, candidateText: string): number {
  if (!currentText) {
    return 0;
  }

  const parts = currentText
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 2);

  if (parts.length === 0) {
    return 0;
  }

  const matches = parts.filter((part) => candidateText.includes(part)).length;
  return Number((matches / parts.length).toFixed(2));
}

function utility(kind: BaseNode['kind']): number {
  switch (kind) {
    case 'intent':
    case 'decision':
    case 'constraint':
    case 'open_loop':
      return 1;
    case 'tool_result':
    case 'artifact_snapshot':
      return 0.85;
    case 'summary':
      return 0.95;
    default:
      return 0.55;
  }
}
