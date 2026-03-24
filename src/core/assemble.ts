import type { AssembleBucket, BaseNode, MemoryChunkPayload, RetrievalCandidate, SummaryNodePayload, TaskState } from '../../schemas/types.js';
import type { AssembleInput, AssembleOutput } from './engine.js';
import type { SessionSnapshot } from './ingest.js';
import {
  extractExplicitNextStep,
  extractExplicitTaskDefinition,
  isExplicitTaskDefinition,
  looksLikeConversationRecall as looksLikeConversationRecallCue,
  looksLikeTaskContinuationQuery,
} from './dialogue-cues.js';
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
  layer?: string;
  sourceFile?: string;
  routeReason?: string;
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
    memoryNamespace: {
      sessionId: input.sessionId,
      agentId: input.agentId,
      workspaceId: input.workspaceId,
    },
  });
  const candidates = retrieval.candidates;
  const buckets = fillBuckets(candidates, snapshot.nodes, input.tokenBudget, input.currentTurnText);
  const selectedNodeIds = expandSelectedNodeIds(buckets, snapshot.nodes);
  const retrievalSummary = candidates.slice(0, 5).map((candidate) => {
    const node = snapshot.nodes.find((item) => item.id === candidate.nodeId);
    const bucket = node ? classifyBucket(node.kind) : undefined;

    return {
      nodeId: candidate.nodeId,
      kind: node?.kind,
      bucket,
      layer: readLayer(node),
      sourceFile: readSourceFile(node),
      routeReason: readRouteReason(node),
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
    systemPromptAddition: buildSystemPrompt(taskState, buckets, snapshot.nodes, selectedNodeIds, input.currentTurnText),
    taskState,
    buckets,
    candidates,
    retrievalSummary,
  };
}

function expandSelectedNodeIds(buckets: AssembleBucket[], nodes: BaseNode[]): Set<string> {
  const selected = new Set(buckets.flatMap((bucket) => bucket.nodeIds));
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));

  for (const bucket of buckets) {
    for (const nodeId of bucket.nodeIds) {
      const node = nodeMap.get(nodeId);
      if (!node || node.kind !== 'summary') {
        continue;
      }

      const payload = node.payload as Partial<SummaryNodePayload> | undefined;
      for (const evidenceRef of payload?.evidenceRefs ?? []) {
        const referencedNode = nodeMap.get(evidenceRef);
        if (referencedNode) {
          selected.add(referencedNode.id);
        }
      }
    }
  }

  return selected;
}

function fillBuckets(
  candidates: RetrievalCandidate[],
  nodes: BaseNode[],
  tokenBudget: number,
  currentTurnText?: string,
): AssembleBucket[] {
  const buckets = createBuckets(tokenBudget);
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));

  seedBucketsWithTopCandidates(buckets, candidates, nodeMap, currentTurnText);

  for (const candidate of candidates) {
    const node = nodeMap.get(candidate.nodeId);
    if (!node) {
      continue;
    }

    const bucket = buckets.find((item) => item.name === classifyBucket(node.kind));
    if (!bucket || bucket.nodeIds.includes(node.id)) {
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

function seedBucketsWithTopCandidates(
  buckets: AssembleBucket[],
  candidates: RetrievalCandidate[],
  nodeMap: Map<string, BaseNode>,
  currentTurnText?: string,
): void {
  for (const bucket of buckets) {
    if (bucket.name === 'recent_dialogue') {
      seedRecentDialogueBucket(bucket, nodeMap, currentTurnText);
      continue;
    }

    const topCandidateForBucket = selectSeedCandidateForBucket(bucket.name, candidates, nodeMap);

    if (!topCandidateForBucket) {
      continue;
    }

    const node = nodeMap.get(topCandidateForBucket.nodeId);
    if (!node) {
      continue;
    }

    if (estimateNodeTokens(node) <= bucket.budgetTokens || node.kind === 'summary' || bucket.nodeIds.length === 0) {
      bucket.nodeIds.push(node.id);
    }
  }
}

function seedRecentDialogueBucket(
  bucket: AssembleBucket,
  nodeMap: Map<string, BaseNode>,
  currentTurnText?: string,
): void {
  const recallConversation = looksLikeConversationRecall(currentTurnText);
  const latestDialogueNodes = [...nodeMap.values()]
    .filter((node) => node.kind === 'message')
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

  const candidates = latestDialogueNodes.slice(0, recallConversation ? 6 : 3);
  const earliestUserMessage = recallConversation && /\bfirst message\b/i.test(currentTurnText ?? '')
    ? [...latestDialogueNodes]
        .reverse()
        .find((node) => ((node.payload as { role?: unknown }).role === 'user'))
    : undefined;

  if (earliestUserMessage && !candidates.some((node) => node.id === earliestUserMessage.id)) {
    candidates.push(earliestUserMessage);
  }

  let usedTokens = 0;
  for (const node of candidates.sort((left, right) => left.createdAt.localeCompare(right.createdAt))) {
    const estimatedTokens = estimateNodeTokens(node);
    if (usedTokens + estimatedTokens > bucket.budgetTokens && bucket.nodeIds.length > 0) {
      continue;
    }

    bucket.nodeIds.push(node.id);
    usedTokens += estimatedTokens;
  }
}

function selectSeedCandidateForBucket(
  bucketName: AssembleBucket['name'],
  candidates: RetrievalCandidate[],
  nodeMap: Map<string, BaseNode>,
): RetrievalCandidate | undefined {
  const bucketCandidates = candidates.filter((candidate) => {
    const node = nodeMap.get(candidate.nodeId);
    return node && classifyBucket(node.kind) === bucketName;
  });

  if (bucketName === 'evidence') {
    const freshestSummaryNode = [...nodeMap.values()]
      .filter((node) => node.kind === 'summary')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

    if (freshestSummaryNode) {
      return bucketCandidates.find((candidate) => candidate.nodeId === freshestSummaryNode.id)
        ?? {
          nodeId: freshestSummaryNode.id,
          graphScore: 1,
          retrievalScore: 0,
          recencyScore: 1,
          utilityScore: 0.95,
          redundancyPenalty: 0,
          finalScore: 0.74,
        };
    }
  }

  if (bucketName === 'memory_patch') {
    return bucketCandidates
      .sort((left, right) => compareMemoryLayerPriority(nodeMap.get(left.nodeId), nodeMap.get(right.nodeId)))
      .at(0);
  }

  return bucketCandidates[0];
}

function createBuckets(tokenBudget: number): AssembleBucket[] {
  return DEFAULT_BUCKET_SPLIT.map(([name, ratio]) => ({
    name,
    budgetTokens: Math.max(32, Math.floor(tokenBudget * ratio)),
    nodeIds: [],
  }));
}

function buildSystemPrompt(
  taskState: TaskState,
  buckets: AssembleBucket[],
  nodes: BaseNode[],
  selectedNodeIds: Set<string>,
  currentTurnText?: string,
): string {
  const bucketSummary = buckets
    .filter((bucket) => bucket.nodeIds.length > 0)
    .map((bucket) => `${bucket.name}:${bucket.nodeIds.length}`)
    .join(', ');
  const dialogueRecallHints = buildDialogueRecallHints(nodes, selectedNodeIds, currentTurnText);
  const continuationHints = buildContinuationHints(nodes, selectedNodeIds, currentTurnText);

  return [
    'HypergraphContextEngine assembled task-state-guided context.',
    taskState.intent ? `Intent: ${taskState.intent}` : 'Intent: unknown',
    taskState.constraints.length ? `Constraints: ${taskState.constraints.join(' | ')}` : undefined,
    taskState.activeDecisions.length ? `Active decisions: ${taskState.activeDecisions.join(' | ')}` : undefined,
    taskState.priorityStatus.length
      ? `Priority status: ${taskState.priorityStatus.map((item) => `${item.item} [${item.status}]`).join(' | ')}`
      : undefined,
    taskState.priorityBacklog.length ? `Priority backlog: ${taskState.priorityBacklog.join(' | ')}` : undefined,
    taskState.openLoops.length ? `Open loops: ${taskState.openLoops.join(' | ')}` : undefined,
    taskState.resolvedOpenLoops.length ? `Resolved loops: ${taskState.resolvedOpenLoops.join(' | ')}` : undefined,
    bucketSummary ? `Buckets: ${bucketSummary}` : undefined,
    ...dialogueRecallHints,
    ...continuationHints,
  ]
    .filter(Boolean)
    .join(' ');
}

function buildDialogueRecallHints(
  nodes: BaseNode[],
  selectedNodeIds: Set<string>,
  currentTurnText?: string,
): string[] {
  if (!looksLikeConversationRecall(currentTurnText)) {
    return [];
  }

  const selectedDialogueNodes = nodes
    .filter((node) => selectedNodeIds.has(node.id) && node.kind === 'message')
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const userDialogue = selectedDialogueNodes.filter((node) => (node.payload as { role?: unknown }).role === 'user');
  const hints: string[] = [];
  const previousUserMessage = userDialogue.at(-2);
  const firstUserMessage = userDialogue[0];

  if (previousUserMessage) {
    const text = readMessageText(previousUserMessage);
    if (text) {
      hints.push(`Immediate previous user message: ${text}`);
    }
  }

  if (/\bfirst message\b/i.test(currentTurnText ?? '') && firstUserMessage) {
    const text = readMessageText(firstUserMessage);
    if (text) {
      hints.push(`First user message in this session: ${text}`);
    }
  }

  return hints;
}

function buildContinuationHints(
  nodes: BaseNode[],
  selectedNodeIds: Set<string>,
  currentTurnText?: string,
): string[] {
  if (!looksLikeTaskContinuationQuery(currentTurnText)) {
    return [];
  }

  const selectedDialogueNodes = nodes
    .filter((node) => selectedNodeIds.has(node.id) && node.kind === 'message')
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const userDialogue = selectedDialogueNodes.filter((node) => (node.payload as { role?: unknown }).role === 'user');
  const assistantDialogue = selectedDialogueNodes.filter((node) => (node.payload as { role?: unknown }).role === 'assistant');
  const latestTaskDefinition = [...userDialogue]
    .reverse()
    .find((node) => {
      const text = readMessageText(node);
      return isExplicitTaskDefinition(text) || (!looksLikeConversationRecall(text) && !looksLikeTaskContinuationQuery(text));
    });
  const latestUserNextStep = [...userDialogue]
    .reverse()
    .map((node) => extractExplicitNextStep(readMessageText(node)))
    .find((value): value is string => Boolean(value));
  const latestAssistantCommitment = [...assistantDialogue]
    .reverse()
    .find((node) => looksLikeAssistantCommitment(readMessageText(node)));
  const hints: string[] = [];

  if (latestTaskDefinition) {
    const text = extractExplicitTaskDefinition(readMessageText(latestTaskDefinition))
      ?? readMessageText(latestTaskDefinition);
    if (text) {
      hints.push(`Latest task-defining user message: ${text}`);
      hints.push(`Canonical current session task: ${text}`);
    }
  }

  if (latestUserNextStep) {
    hints.push(`Latest user-defined next step: ${latestUserNextStep}`);
    hints.push(`Canonical current session next step: ${latestUserNextStep}`);
  } else if (latestAssistantCommitment) {
    const text = readMessageText(latestAssistantCommitment);
    if (text) {
      hints.push(`Latest assistant commitment: ${text}`);
      hints.push(`Canonical current session next step: ${text}`);
    }
  }

  if (latestTaskDefinition || latestUserNextStep || latestAssistantCommitment) {
    hints.push('For current-task or next-step recall, prefer the canonical current session task and next step above over unrelated long-term memory from other sessions.');
  }

  return hints;
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

function looksLikeConversationRecall(currentTurnText?: string): boolean {
  const text = currentTurnText ?? '';
  return looksLikeConversationRecallCue(text) || /\bremember this exactly\b/i.test(text);
}

function looksLikeAssistantCommitment(text?: string): boolean {
  const normalized = (text ?? '').trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return /\bnext step\b/.test(normalized)
    || /\bi(?:'| wi)ll\b/.test(normalized)
    || /\bready\b/.test(normalized)
    || /\bupdated\b/.test(normalized)
    || /\bstored\b/.test(normalized)
    || /\bconfirm\b/.test(normalized)
    || /\bcontinue\b/.test(normalized);
}

function nodeToMessage(node: BaseNode): Record<string, unknown> {
  return {
    id: node.id,
    kind: node.kind,
    createdAt: node.createdAt,
    content: node.payload,
  };
}

function readMessageText(node: BaseNode): string | undefined {
  const payload = node.payload as { text?: unknown };
  return typeof payload.text === 'string' && payload.text.trim() ? payload.text.trim() : undefined;
}

function readLayer(node: BaseNode | undefined): string | undefined {
  if (!node || node.kind !== 'memory_chunk') {
    return undefined;
  }

  return (node.payload as Partial<MemoryChunkPayload> | undefined)?.layer;
}

function readSourceFile(node: BaseNode | undefined): string | undefined {
  if (!node || node.kind !== 'memory_chunk') {
    return undefined;
  }

  return (node.payload as Partial<MemoryChunkPayload> | undefined)?.sourceFile;
}

function readRouteReason(node: BaseNode | undefined): string | undefined {
  if (!node || node.kind !== 'memory_chunk') {
    return undefined;
  }

  return (node.payload as Partial<MemoryChunkPayload> | undefined)?.routeReason;
}

function compareMemoryLayerPriority(left: BaseNode | undefined, right: BaseNode | undefined): number {
  return layerPriority(right) - layerPriority(left);
}

function layerPriority(node: BaseNode | undefined): number {
  const layer = readLayer(node);
  switch (layer) {
    case 'hot':
      return 3;
    case 'warm':
      return 2;
    case 'cold':
      return 1;
    default:
      return 0;
  }
}
