import type { BaseNode, GraphEdge, TaskState } from '../schemas/types.js';

const MAX_ITEMS_PER_BUCKET = 8;

function uniqueLimited(values: Array<string | undefined>, limit = MAX_ITEMS_PER_BUCKET): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    if (!value) {
      continue;
    }

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

export function createEmptyTaskState(sessionId: string, at = new Date().toISOString()): TaskState {
  return {
    sessionId,
    intent: null,
    constraints: [],
    activeDecisions: [],
    candidateDecisions: [],
    toolFacts: [],
    artifactState: [],
    openLoops: [],
    resolvedOpenLoops: [],
    relevantMemories: [],
    confidence: 0,
    lastUpdatedAt: at,
  };
}

export function materializeTaskState(sessionId: string, nodes: BaseNode[], edges: GraphEdge[] = []): TaskState {
  const sortedNodes = [...nodes].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const latestAt = sortedNodes.at(-1)?.createdAt ?? new Date().toISOString();

  const intentNodes = sortedNodes.filter((node) => node.kind === 'intent');
  const constraintNodes = sortedNodes.filter((node) => node.kind === 'constraint');
  const decisionNodes = sortedNodes.filter((node) => node.kind === 'decision');
  const toolNodes = sortedNodes.filter((node) => node.kind === 'tool_result');
  const artifactNodes = sortedNodes.filter((node) => node.kind === 'artifact_snapshot');
  const openLoopNodes = sortedNodes.filter((node) => node.kind === 'open_loop');
  const memoryNodes = sortedNodes.filter((node) => node.kind === 'memory_chunk');
  const resolvedOpenLoopIds = new Set(edges.filter((edge) => edge.kind === 'resolves').map((edge) => edge.to));

  const intent = selectBestIntent(intentNodes) ?? null;

  const constraints = uniqueLimited(
    constraintNodes.map((node) => readPrimaryText(node.payload) ?? readSecondaryText(node.payload)),
  );

  const activeDecisions = uniqueLimited(
    decisionNodes
      .filter((node) => node.payload.status !== 'candidate')
      .map((node) => readPrimaryText(node.payload) ?? readSecondaryText(node.payload)),
  );

  const candidateDecisions = uniqueLimited(
    decisionNodes
      .filter((node) => node.payload.status === 'candidate')
      .map((node) => readPrimaryText(node.payload) ?? readSecondaryText(node.payload)),
  );

  const toolFacts = uniqueLimited(
    toolNodes.map((node) => {
      const tool = asOptionalString(node.payload.toolName);
      const summary = readPrimaryText(node.payload) ?? readSecondaryText(node.payload);
      return tool && summary ? `${tool}: ${summary}` : summary ?? tool;
    }),
  );

  const artifactState = uniqueLimited(
    artifactNodes.map((node) => readPrimaryText(node.payload) ?? readSecondaryText(node.payload)),
  );

  const openLoops = uniqueLimited(
    openLoopNodes
      .filter((node) => !resolvedOpenLoopIds.has(node.id))
      .map((node) => readPrimaryText(node.payload) ?? readSecondaryText(node.payload)),
  );

  const resolvedOpenLoops = uniqueLimited(
    openLoopNodes
      .filter((node) => resolvedOpenLoopIds.has(node.id))
      .map((node) => readPrimaryText(node.payload) ?? readSecondaryText(node.payload)),
  );

  const relevantMemories = uniqueLimited(
    memoryNodes.map((node) => readPrimaryText(node.payload) ?? readSecondaryText(node.payload)),
  );

  const evidenceBuckets = [
    intent ? 1 : 0,
    constraints.length > 0 ? 1 : 0,
    activeDecisions.length > 0 ? 1 : 0,
    toolFacts.length > 0 ? 1 : 0,
    artifactState.length > 0 ? 1 : 0,
    openLoops.length > 0 || resolvedOpenLoops.length > 0 ? 1 : 0,
  ].reduce((sum, score) => sum + score, 0);

  return {
    sessionId,
    intent,
    constraints,
    activeDecisions,
    candidateDecisions,
    toolFacts,
    artifactState,
    openLoops,
    resolvedOpenLoops,
    relevantMemories,
    confidence: Math.min(1, Number((evidenceBuckets / 6).toFixed(2))),
    lastUpdatedAt: latestAt,
  };
}

export function mergeTaskState(base: TaskState, patch: Partial<TaskState>): TaskState {
  return {
    ...base,
    ...patch,
    constraints: uniqueLimited([...(base.constraints ?? []), ...(patch.constraints ?? [])]),
    activeDecisions: uniqueLimited([...(base.activeDecisions ?? []), ...(patch.activeDecisions ?? [])]),
    candidateDecisions: uniqueLimited([...(base.candidateDecisions ?? []), ...(patch.candidateDecisions ?? [])]),
    toolFacts: uniqueLimited([...(base.toolFacts ?? []), ...(patch.toolFacts ?? [])]),
    artifactState: uniqueLimited([...(base.artifactState ?? []), ...(patch.artifactState ?? [])]),
    openLoops: uniqueLimited([...(base.openLoops ?? []), ...(patch.openLoops ?? [])]),
    resolvedOpenLoops: uniqueLimited([...(base.resolvedOpenLoops ?? []), ...(patch.resolvedOpenLoops ?? [])]),
    relevantMemories: uniqueLimited([...(base.relevantMemories ?? []), ...(patch.relevantMemories ?? [])]),
    confidence: patch.confidence ?? base.confidence,
    lastUpdatedAt: patch.lastUpdatedAt ?? base.lastUpdatedAt,
  };
}

function selectBestIntent(intentNodes: BaseNode[]): string | undefined {
  const scored = intentNodes
    .map((node, index) => {
      const text = readPrimaryText(node.payload);
      if (!text) {
        return undefined;
      }

      return {
        text,
        score: scoreIntentText(text, index, intentNodes.length),
      };
    })
    .filter((value): value is { text: string; score: number } => Boolean(value))
    .sort((a, b) => b.score - a.score);

  return scored[0]?.text;
}

function scoreIntentText(text: string, index: number, total: number): number {
  const normalized = text.toLowerCase();
  let score = 0.2 + index / Math.max(total, 1);

  if (/[.!]$/.test(text)) {
    score += 0.05;
  }

  if (/\b(build|implement|create|fix|add|write|prepare|design|ship)\b/i.test(text)) {
    score += 1;
  }

  if (/\b(priority|goal|mvp|please|need to|must|should)\b/i.test(text) || /优先|实现|构建|请|需要|必须/.test(text)) {
    score += 0.75;
  }

  if (/\?$/.test(text) || /\b(also|great|thanks|thank you|btw)\b/i.test(normalized)) {
    score -= 0.6;
  }

  if (text.length > 24) {
    score += 0.1;
  }

  return score;
}

function readPrimaryText(payload: Record<string, unknown>): string | undefined {
  return [payload.text, payload.summary, payload.intent, payload.question, payload.value]
    .map(asOptionalString)
    .find(Boolean);
}

function readSecondaryText(payload: Record<string, unknown>): string | undefined {
  return [payload.description, payload.result, payload.output, payload.title]
    .map(asOptionalString)
    .find(Boolean);
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
