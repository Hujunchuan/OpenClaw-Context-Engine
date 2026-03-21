import type { AssembleBucket, BaseNode, RetrievalCandidate, TaskState } from '../schemas/types.js';
import type { AssembleInput, AssembleOutput } from './engine.js';
import type { SessionSnapshot } from './ingest.js';
import { retrieveRelevantNodes } from './retriever.js';
import { createEmptyTaskState, materializeTaskState } from './task-state.js';

const DEFAULT_BUCKET_SPLIT: Array<[AssembleBucket['name'], number]> = [
  ['recent_dialogue', 0.35],
  ['task_state', 0.3],
  ['evidence', 0.2],
  ['artifact', 0.1],
  ['memory_patch', 0.05],
];

export interface RetrievalSummaryItem {
  nodeId: string;
  kind?: string;
  bucket?: string;
  selected: boolean;
  finalScore: number;
  graphScore: number;
  retrievalScore: number;
  recencyScore: number;
  utilityScore: number;
  redundancyPenalty: number;
}

export interface AssembleComputation {
  taskState: TaskState;
  buckets: AssembleBucket[];
  candidates: RetrievalCandidate[];
  retrievalSummary: RetrievalSummaryItem[];
}

export function assembleContext(
  snapshot: SessionSnapshot | undefined,
  input: AssembleInput,
): AssembleOutput & AssembleComputation {
  const emptyTaskState = createEmptyTaskState(input.sessionId);

  if (!snapshot) {
    return {
      messages: [],
      systemPromptAddition: 'HypergraphContextEngine fallback assemble: no session snapshot yet, using empty task state.',
      taskState: emptyTaskState,
      buckets: createBuckets(input.tokenBudget),
      candidates: [],
      retrievalSummary: [],
    };
  }

  const taskState = materializeTaskState(input.sessionId, snapshot.nodes, snapshot.edges);
  const retrieval = retrieveRelevantNodes({
    nodes: snapshot.nodes,
    edges: snapshot.edges,
    taskState,
    currentTurnText: input.currentTurnText,
    limit: Math.max(8, Math.ceil(snapshot.nodes.length * 0.6)),
  });
  const candidates = retrieval.candidates;
  const buckets = fillBuckets(candidates, snapshot.nodes, input.tokenBudget);
  const selectedNodeIds = new Set(buckets.flatMap((bucket) => bucket.nodeIds));
  const retrievalSummary = candidates.slice(0, 5).map((candidate) => {
    const node = snapshot.nodes.find((item) => item.id === candidate.nodeId);
    const bucket = node ? classifyBucket(node.kind) : undefined;

    return {
      nodeId: candidate.nodeId,
      kind: node?.kind,
      bucket,
      selected: selectedNodeIds.has(candidate.nodeId),
      finalScore: candidate.finalScore,
      graphScore: candidate.graphScore,
      retrievalScore: candidate.retrievalScore,
      recencyScore: candidate.recencyScore,
      utilityScore: candidate.utilityScore,
      redundancyPenalty: candidate.redundancyPenalty,
    };
  });
  const selectedMessages = snapshot.nodes
    .filter((node) => selectedNodeIds.has(node.id))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((node) => nodeToMessage(node));

  return {
    messages: selectedMessages,
    systemPromptAddition: buildSystemPrompt(taskState, buckets),
    taskState,
    buckets,
    candidates,
    retrievalSummary,
  };
}

function fillBuckets(
  candidates: RetrievalCandidate[],
  nodes: BaseNode[],
  tokenBudget: number,
): AssembleBucket[] {
  const buckets = createBuckets(tokenBudget);
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));

  for (const candidate of candidates) {
    const node = nodeMap.get(candidate.nodeId);
    if (!node) {
      continue;
    }

    const bucket = buckets.find((item) => item.name === classifyBucket(node.kind));
    if (!bucket) {
      continue;
    }

    const estimatedTokens = estimateNodeTokens(node);
    const usedTokens = bucket.nodeIds
      .map((id) => nodeMap.get(id))
      .filter((value): value is BaseNode => Boolean(value))
      .reduce((sum, value) => sum + estimateNodeTokens(value), 0);

    if (usedTokens + estimatedTokens > bucket.budgetTokens) {
      continue;
    }

    bucket.nodeIds.push(node.id);
  }

  return buckets;
}

function createBuckets(tokenBudget: number): AssembleBucket[] {
  return DEFAULT_BUCKET_SPLIT.map(([name, ratio]) => ({
    name,
    budgetTokens: Math.max(32, Math.floor(tokenBudget * ratio)),
    nodeIds: [],
  }));
}

function buildSystemPrompt(taskState: TaskState, buckets: AssembleBucket[]): string {
  const bucketSummary = buckets
    .filter((bucket) => bucket.nodeIds.length > 0)
    .map((bucket) => `${bucket.name}:${bucket.nodeIds.length}`)
    .join(', ');

  return [
    'HypergraphContextEngine assembled task-state-guided context.',
    taskState.intent ? `Intent: ${taskState.intent}` : 'Intent: unknown',
    taskState.constraints.length ? `Constraints: ${taskState.constraints.join(' | ')}` : undefined,
    taskState.activeDecisions.length ? `Active decisions: ${taskState.activeDecisions.join(' | ')}` : undefined,
    taskState.openLoops.length ? `Open loops: ${taskState.openLoops.join(' | ')}` : undefined,
    taskState.resolvedOpenLoops.length ? `Resolved loops: ${taskState.resolvedOpenLoops.join(' | ')}` : undefined,
    bucketSummary ? `Buckets: ${bucketSummary}` : undefined,
  ]
    .filter(Boolean)
    .join(' ');
}

function classifyBucket(kind: BaseNode['kind']): AssembleBucket['name'] {
  switch (kind) {
    case 'intent':
    case 'decision':
    case 'constraint':
    case 'open_loop':
      return 'task_state';
    case 'tool_result':
    case 'tool_call':
    case 'summary':
      return 'evidence';
    case 'artifact_snapshot':
      return 'artifact';
    case 'memory_chunk':
      return 'memory_patch';
    default:
      return 'recent_dialogue';
  }
}

function estimateNodeTokens(node: BaseNode): number {
  return Math.max(16, Math.ceil(JSON.stringify(node.payload).length / 4));
}

function nodeToMessage(node: BaseNode): Record<string, unknown> {
  return {
    id: node.id,
    kind: node.kind,
    createdAt: node.createdAt,
    content: node.payload,
  };
}
