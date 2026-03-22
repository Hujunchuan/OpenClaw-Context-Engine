import type { BaseNode, GraphEdge, MemoryChunkPayload, RetrievalCandidate, TaskState } from '../../schemas/types.js';

export interface RetrieveInput {
  nodes: BaseNode[];
  edges?: GraphEdge[];
  taskState: TaskState;
  currentTurnText?: string;
  limit?: number;
}

export interface RetrieveOutput {
  candidates: RetrievalCandidate[];
  selectedNodeIds: string[];
}

export function retrieveRelevantNodes(input: RetrieveInput): RetrieveOutput {
  const scored = scoreCandidates(input.nodes, input.taskState, input.currentTurnText, input.edges ?? []);
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
): RetrievalCandidate[] {
  const currentText = (currentTurnText ?? '').toLowerCase();
  const edgeIndex = buildEdgeIndex(edges);

  return nodes
    .map((node, index) => {
      const text = JSON.stringify(node.payload).toLowerCase();
      const graphScore = graphAffinity(node, taskState, edgeIndex);
      const retrievalScore = currentText && text.includes(currentText) ? 1 : keywordOverlap(currentText, text);
      const recencyScore = Math.max(0.1, (index + 1) / Math.max(nodes.length, 1));
      const utilityScore = utility(node.kind);
      const redundancyPenalty = index > 0 && nodes[index - 1]?.kind === node.kind ? 0.15 : 0;
      const layerWeight = resolveLayerWeight(node);
      const finalScore = Number(
        ((0.35 * graphScore + 0.25 * retrievalScore + 0.2 * recencyScore + 0.2 * utilityScore) * layerWeight - redundancyPenalty).toFixed(3),
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
