import type {
  BaseNode,
  GraphEdge,
  MemoryChunkPayload,
  PriorityStatusItem,
  RelevantMemoryRef,
  SummaryNodePayload,
  TaskState,
} from '../../schemas/types.js';

const MAX_ITEMS_PER_BUCKET = 8;

function uniqueLimited(values: Array<string | undefined>, limit = MAX_ITEMS_PER_BUCKET): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const cleaned = sanitizeStateText(value);
    if (!cleaned) {
      continue;
    }

    if (seen.has(cleaned)) {
      continue;
    }

    seen.add(cleaned);
    out.push(cleaned);

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
    priorityBacklog: [],
    priorityStatus: [],
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
  const summarySeed = readLatestSummaryTaskState(sessionId, sortedNodes);

  const intentNodes = sortedNodes.filter((node) => node.kind === 'intent');
  const constraintNodes = sortedNodes.filter((node) => node.kind === 'constraint');
  const decisionNodes = sortedNodes.filter((node) => node.kind === 'decision');
  const toolNodes = sortedNodes.filter((node) => node.kind === 'tool_result');
  const artifactNodes = sortedNodes.filter((node) => node.kind === 'artifact_snapshot');
  const openLoopNodes = sortedNodes.filter((node) => node.kind === 'open_loop');
  const memoryNodes = sortedNodes.filter((node) => node.kind === 'memory_chunk');
  const resolvedOpenLoopIds = new Set(edges.filter((edge) => edge.kind === 'resolves').map((edge) => edge.to));
  const invalidatedOpenLoopIds = new Set(edges.filter((edge) => edge.kind === 'invalidates').map((edge) => edge.to));
  const supersededDecisionIds = new Set(edges.filter((edge) => edge.kind === 'supersedes').map((edge) => edge.to));

  const intent = sanitizeStateText(selectBestIntent(intentNodes) ?? summarySeed.intent ?? undefined) ?? null;

  const constraints = uniqueLimited([
    ...constraintNodes.map((node) => readPrimaryText(node.payload) ?? readSecondaryText(node.payload)),
    ...(summarySeed.constraints ?? []),
  ]).filter((value) => value !== intent);

  const activeDecisions = uniqueLimited([
    ...decisionNodes
      .filter((node) => node.payload.status !== 'candidate' && !supersededDecisionIds.has(node.id))
      .map((node) => readPrimaryText(node.payload) ?? readSecondaryText(node.payload)),
    ...(summarySeed.activeDecisions ?? []),
  ]);
  const activeDecisionKeys = activeDecisions.map((value) => normalizeStateText(value));

  const candidateDecisions = uniqueLimited([
    ...decisionNodes
      .filter((node) => node.payload.status === 'candidate')
      .map((node) => readPrimaryText(node.payload) ?? readSecondaryText(node.payload)),
    ...(summarySeed.candidateDecisions ?? []),
  ]).filter((value) => !activeDecisionKeys.some((activeValue) => areStateTextsEquivalent(activeValue, normalizeStateText(value))));

  const toolFacts = uniqueLimited(
    normalizeToolFacts([
      ...toolNodes.map((node) => {
        const tool = asOptionalString(node.payload.toolName);
        const summary = readPrimaryText(node.payload) ?? readSecondaryText(node.payload);
        return tool && summary ? `${tool}: ${summary}` : summary ?? tool;
      }),
      ...(summarySeed.toolFacts ?? []),
    ]),
  );

  const artifactState = uniqueLimited([
    ...artifactNodes.map((node) => readArtifactText(node.payload) ?? readSecondaryText(node.payload)),
    ...(summarySeed.artifactState ?? []),
  ]);

  const resolvedOpenLoops = uniqueLimited([
    ...openLoopNodes
      .filter((node) => resolvedOpenLoopIds.has(node.id) && !invalidatedOpenLoopIds.has(node.id))
      .map((node) => readPrimaryText(node.payload) ?? readSecondaryText(node.payload)),
    ...(summarySeed.resolvedOpenLoops ?? []),
  ]);

  const explicitOpenLoops = uniqueLimited([
    ...openLoopNodes
      .filter((node) => !resolvedOpenLoopIds.has(node.id))
      .map((node) => readPrimaryText(node.payload) ?? readSecondaryText(node.payload)),
    ...(summarySeed.openLoops ?? []),
  ]).filter((value) => !looksLikeRecallOnlyOpenLoop(value));

  const priorityStatus = mergePriorityStatus([
    ...derivePriorityStatus(sortedNodes, {
      constraints,
      activeDecisions,
      candidateDecisions,
      toolFacts,
      artifactState,
      explicitOpenLoops,
      resolvedOpenLoopTexts: resolvedOpenLoops,
    }),
    ...(summarySeed.priorityStatus ?? []),
  ]);

  const priorityBacklog = uniqueLimited([
    ...priorityStatus
      .filter((item) => item.status === 'pending')
      .map((item) => `Priority backlog: ${item.item}`),
    ...(summarySeed.priorityBacklog ?? []),
  ]);

  const openLoops = uniqueLimited(explicitOpenLoops);

  const relevantMemories = mergeRelevantMemories([
    ...memoryNodes.map((node) => toRelevantMemoryRef(node)),
    ...(summarySeed.relevantMemories ?? []),
  ]);

  const stillResolvedOpenLoops = resolvedOpenLoops.filter((value) => !isReopenedByOpenLoop(value, openLoops));
  const unresolvedOpenLoops = openLoops.filter((value) => !isCoveredByResolvedLoop(value, stillResolvedOpenLoops));

  const evidenceBuckets = [
    intent ? 1 : 0,
    constraints.length > 0 ? 1 : 0,
    activeDecisions.length > 0 ? 1 : 0,
    toolFacts.length > 0 ? 1 : 0,
    artifactState.length > 0 ? 1 : 0,
    unresolvedOpenLoops.length > 0 || stillResolvedOpenLoops.length > 0 ? 1 : 0,
  ].reduce((sum, score) => sum + score, 0);

  return {
    sessionId,
    intent,
    constraints,
    activeDecisions,
    candidateDecisions,
    toolFacts,
    artifactState,
    priorityBacklog,
    priorityStatus,
    openLoops: unresolvedOpenLoops,
    resolvedOpenLoops: stillResolvedOpenLoops,
    relevantMemories,
    confidence: Math.min(1, Number((Math.max(evidenceBuckets / 6, summarySeed.confidence ?? 0)).toFixed(2))),
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
    priorityBacklog: uniqueLimited([...(base.priorityBacklog ?? []), ...(patch.priorityBacklog ?? [])]),
    priorityStatus: mergePriorityStatus([...(base.priorityStatus ?? []), ...(patch.priorityStatus ?? [])]),
    openLoops: uniqueLimited([...(base.openLoops ?? []), ...(patch.openLoops ?? [])]),
    resolvedOpenLoops: uniqueLimited([...(base.resolvedOpenLoops ?? []), ...(patch.resolvedOpenLoops ?? [])]),
    relevantMemories: mergeRelevantMemories([...(base.relevantMemories ?? []), ...(patch.relevantMemories ?? [])]),
    confidence: patch.confidence ?? base.confidence,
    lastUpdatedAt: patch.lastUpdatedAt ?? base.lastUpdatedAt,
  };
}

function readLatestSummaryTaskState(sessionId: string, nodes: BaseNode[]): TaskState {
  const summaryNodes = [...nodes].filter((node) => node.kind === 'summary');
  const latestValidSummaryNode = [...summaryNodes].reverse().find((node) => !isExpiredSummary(node));
  const latestSummaryNode = latestValidSummaryNode ?? summaryNodes.at(-1);
  const payload = latestSummaryNode?.payload as Partial<SummaryNodePayload> | undefined;
  const confidence = asOptionalNumber(payload?.confidence) ?? 0;

  return {
    sessionId,
    intent: asOptionalString(payload?.intent) ?? null,
    constraints: asStringArray(payload?.constraints),
    activeDecisions: asStringArray(payload?.finalDecisions),
    candidateDecisions: asStringArray(payload?.candidateDecisions),
    toolFacts: asStringArray(payload?.toolFacts),
    artifactState: asStringArray(payload?.artifactFinalState),
    priorityBacklog: asStringArray(payload?.priorityBacklog),
    priorityStatus: asPriorityStatusArray(payload?.priorityStatus),
    openLoops: asStringArray(payload?.openLoopsRemaining),
    resolvedOpenLoops: asStringArray(payload?.resolvedOpenLoops),
    relevantMemories: asRelevantMemoryArray(payload?.relevantMemories),
    confidence: isExpiredSummary(latestSummaryNode) ? Number((confidence * 0.5).toFixed(2)) : confidence,
    lastUpdatedAt: latestSummaryNode?.createdAt ?? new Date().toISOString(),
  };
}

function isExpiredSummary(node: BaseNode | undefined): boolean {
  if (!node || node.kind !== 'summary') {
    return false;
  }

  const payload = node.payload as Partial<SummaryNodePayload> | undefined;
  const validUntil = asOptionalString(payload?.validUntil);
  if (!validUntil) {
    return false;
  }

  return validUntil < new Date().toISOString();
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
  return [payload.summary, payload.text, payload.intent, payload.question, payload.value]
    .map(asOptionalString)
    .find(Boolean);
}

function derivePriorityStatus(
  nodes: BaseNode[],
  state: {
    constraints: string[];
    activeDecisions: string[];
    candidateDecisions: string[];
    toolFacts: string[];
    artifactState: string[];
    explicitOpenLoops: string[];
    resolvedOpenLoopTexts: string[];
  },
): PriorityStatusItem[] {
  const latestPriorityItems = selectLatestPriorityList(nodes);

  return latestPriorityItems
    .map((item) => ({
      item,
      status: classifyPriorityItem(item, state),
      source: 'priority_list' as const,
    }))
    .filter((value) => Boolean(normalizeStateText(value.item)));
}

function selectLatestPriorityList(nodes: BaseNode[]): string[] {
  for (const node of [...nodes].reverse()) {
    if (node.kind !== 'message' && node.kind !== 'intent') {
      continue;
    }

    const text = readPrimaryText(node.payload);
    if (!text) {
      continue;
    }

    const items = parsePriorityListItems(text);
    if (items.length >= 2) {
      return items;
    }
  }

  return [];
}

function parsePriorityListItems(text: string): string[] {
  const hasPriorityCue = /\b(priority|priorities|order|todo|next steps?)\b/i.test(text) || /优先顺序|优先级|待办/.test(text);
  if (!hasPriorityCue) {
    return [];
  }

  const numberedItems = [...text.matchAll(/(?:^|[\s:：])(\d+[.)]\s*.+?)(?=(?:[\s:：]+\d+[.)]\s)|$)/gms)]
    .map((match) => match[1] ?? '')
    .map((value) => value.replace(/^\d+[.)]\s*/, ''))
    .map(sanitizePriorityItem)
    .filter((value): value is string => Boolean(value));

  if (numberedItems.length >= 2) {
    return numberedItems;
  }

  const multilineCandidates = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => /^\d+[.)]\s+/.test(line));

  if (multilineCandidates.length < 2) {
    return [];
  }

  return multilineCandidates
    .map((line) => sanitizePriorityItem(line.replace(/^\d+[.)]\s+/, '')))
    .filter((value): value is string => Boolean(value));
}

function sanitizePriorityItem(value: string): string | undefined {
  const normalized = value
    .split(/(?:[。！？]\s*|\.\s+(?=(?:Please|please|Keep|keep|Must|must|Should|should|Need|need|请|保持|务必|需要)))/u)[0]
    ?.replace(/[;；,，。.!！?？]+$/g, '')
    .replace(/^(task-state|ingest|assemble|compact)\s*[:：-]\s*/i, '$1 ')
    .trim();

  if (!normalized || normalized.length < 2) {
    return undefined;
  }

  return normalized;
}

function classifyPriorityItem(
  item: string,
  state: {
    constraints: string[];
    activeDecisions: string[];
    candidateDecisions: string[];
    toolFacts: string[];
    artifactState: string[];
    explicitOpenLoops: string[];
    resolvedOpenLoopTexts: string[];
  },
): PriorityStatusItem['status'] {
  const normalizedItem = normalizeStateText(item);
  if (!normalizedItem) {
    return 'pending';
  }

  const openLoop = state.explicitOpenLoops.some((value) => matchesPriorityCoverage(value, normalizedItem));
  if (openLoop) {
    return 'open_loop';
  }

  const resolved = [
    ...state.resolvedOpenLoopTexts,
    ...state.artifactState,
    ...state.toolFacts.filter((value) => hasCompletionCue(value)),
    ...state.activeDecisions.filter((value) => hasStrongCompletionCue(value)),
  ].some((value) => matchesPriorityCoverage(value, normalizedItem));
  if (resolved) {
    return 'resolved';
  }

  const active = [...state.activeDecisions, ...state.candidateDecisions, ...state.constraints, ...state.toolFacts].some((value) => matchesPriorityCoverage(value, normalizedItem));
  if (active) {
    return 'active';
  }

  return 'pending';
}

function matchesPriorityCoverage(candidate: string, normalizedItem: string): boolean {
  const normalizedCandidate = normalizeStateText(candidate);
  return normalizedCandidate.includes(normalizedItem)
    || normalizedItem.includes(normalizedCandidate)
    || areStateTextsEquivalent(normalizedCandidate, normalizedItem);
}

function hasCompletionCue(text: string): boolean {
  return /\b(committed|pushed|ran|completed|finished|resolved|implemented|added|created|updated|summary created|pruned)\b/i.test(text)
    || /已完成|完成了|已提交|已推送|运行了|实现了|添加了|创建了|更新了/.test(text);
}

function hasStrongCompletionCue(text: string): boolean {
  return /\b(committed|pushed|ran|completed|finished|resolved|summary created|pruned)\b/i.test(text)
    || /已完成|完成了|已提交|已推送|运行了/.test(text);
}

function mergePriorityStatus(values: PriorityStatusItem[]): PriorityStatusItem[] {
  const merged = new Map<string, PriorityStatusItem>();
  const rank: Record<PriorityStatusItem['status'], number> = {
    pending: 0,
    open_loop: 1,
    active: 2,
    resolved: 3,
  };

  for (const value of values) {
    const normalizedItem = normalizeStateText(value.item);
    if (!normalizedItem) {
      continue;
    }

    const existing = merged.get(normalizedItem);
    if (!existing || rank[value.status] >= rank[existing.status]) {
      merged.set(normalizedItem, {
        item: value.item.trim(),
        status: value.status,
        source: value.source,
      });
    }
  }

  return [...merged.values()];
}

function isCoveredByResolvedLoop(loop: string, resolvedLoops: string[]): boolean {
  const normalizedLoopTokens = tokenize(loop);
  if (normalizedLoopTokens.size === 0) {
    return false;
  }

  return resolvedLoops.some((resolvedLoop) => {
    if (resolvedLoop === loop) {
      return true;
    }

    const resolvedTokens = tokenize(resolvedLoop);
    if (resolvedTokens.size === 0) {
      return false;
    }

    let shared = 0;
    for (const token of normalizedLoopTokens) {
      if (resolvedTokens.has(token)) {
        shared += 1;
      }
    }

    return shared >= 3 || (shared >= 2 && [...normalizedLoopTokens].some((token) => token.length >= 6 && resolvedTokens.has(token)));
  });
}

function isReopenedByOpenLoop(resolvedLoop: string, openLoops: string[]): boolean {
  const resolvedTokens = tokenize(resolvedLoop);
  if (resolvedTokens.size === 0) {
    return false;
  }

  return openLoops.some((openLoop) => {
    if (!hasReopenCue(openLoop)) {
      return false;
    }

    const openLoopTokens = tokenize(openLoop);
    if (openLoopTokens.size === 0) {
      return false;
    }

    let shared = 0;
    for (const token of resolvedTokens) {
      if (openLoopTokens.has(token)) {
        shared += 1;
      }
    }

    return shared >= 3 || (shared >= 2 && [...resolvedTokens].some((token) => token.length >= 6 && openLoopTokens.has(token)));
  });
}

function hasReopenCue(text: string): boolean {
  return /\b(still|again|actually|reopen|reopened|re-open|remaining|left|regression)\b/i.test(text)
    || /仍然|还是|重新|又|遗留|回归/.test(text);
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}_/.-]+/u)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3),
  );
}

function normalizeStateText(value: string): string {
  return applyStateAliases(
    value
      .toLowerCase()
      .replace(/[\s\p{P}]+/gu, ' ')
      .trim(),
  );
}

function areStateTextsEquivalent(left: string, right: string): boolean {
  if (!left || !right) {
    return false;
  }

  if (left === right) {
    return true;
  }

  const leftTokens = new Set(left.split(/\s+/).map(normalizeStateToken).filter((token) => token.length >= 4));
  const rightTokens = new Set(right.split(/\s+/).map(normalizeStateToken).filter((token) => token.length >= 4));
  if (!leftTokens.size || !rightTokens.size) {
    return false;
  }

  let shared = 0;
  const sharedTokens: string[] = [];
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      shared += 1;
      sharedTokens.push(token);
    }
  }

  return shared >= 2
    || shared >= Math.min(leftTokens.size, rightTokens.size)
    || sharedTokens.some((token) => token.length >= 8 && token.includes('-'));
}

function normalizeStateToken(token: string): string {
  return applyStateAliases(token.replace(/(?:ing|ed|es|s)$/i, ''));
}

function applyStateAliases(value: string): string {
  return value
    .replace(/\btask\s+state\b/gi, 'task-state')
    .replace(/\btaskstate\b/gi, 'task-state')
    .replace(/\btoy\s+demo(?:\s*\/\s*|\s+)fixtures\b/gi, 'toy-demo-fixtures')
    .replace(/\btoy\s+fixtures\b/gi, 'toy-demo-fixtures')
    .replace(/\bdemo(?:\s*\/\s*|\s+)fixtures\b/gi, 'toy-demo-fixtures')
    .replace(/\bfixtures?\s+demo\b/gi, 'toy-demo-fixtures')
    .replace(/\btoy-demo-fixtures\s+demo\b/gi, 'toy-demo-fixtures')
    .replace(/\btoy-demo-fixtures\s+output\b/gi, 'toy-demo-fixtures')
    .replace(/\btoy\s+fixtures\s+demo\b/gi, 'toy-demo-fixtures')
    .replace(/\bran\s+toy\s+demo\s+fixtures\b/gi, 'toy-demo-fixtures')
    .replace(/\bcompact\s+minimal(?:\s+version)?\b/gi, 'compact-minimal')
    .replace(/compact\s*最小版/gi, 'compact-minimal')
    .replace(/\bran\s+minimal\s+compact\s+session\s+snapshot\b/gi, 'compact-minimal')
    .replace(/\bcommit(?:ted)?\s*\+\s*push(?:ed)?\b/gi, 'commit-push')
    .replace(/\bcommit(?:ted)?\s+push(?:ed)?\b/gi, 'commit-push')
    .replace(/\bcommit(?:ted)?\s+(?:and\s+)?push(?:ed)?\b/gi, 'commit-push')
    .replace(/\bcommit-push\s+(?:to|到)\s+github\b/gi, 'commit-push github')
    .replace(/\bpushed\s+changes\s+to\s+github\b/gi, 'commit-push github')
    .replace(/\bpush\s+to\s+github\b/gi, 'github-push')
    .replace(/\bpush\s+github\b/gi, 'github-push')
    .replace(/\bcommit(?:ted)?\s+github-push\b/gi, 'commit-push github')
    .replace(/\bcommit-github-push\b/gi, 'commit-push github')
    .replace(/(?:\bto\s+github\b|到\s*github)/gi, 'github');
}

function normalizeToolFacts(values: Array<string | undefined>): string[] {
  const preferredBySummary = new Map<string, string>();

  for (const value of values) {
    if (!value) {
      continue;
    }

    const normalized = value.trim();
    if (!normalized) {
      continue;
    }

    const match = normalized.match(/^([^:]+):\s+(.*)$/);
    const summary = (match?.[2] ?? normalized).trim().toLowerCase();
    const existing = preferredBySummary.get(summary);

    if (!existing || (match && !existing.includes(': '))) {
      preferredBySummary.set(summary, normalized);
    }
  }

  return [...preferredBySummary.values()];
}

function readArtifactText(payload: Record<string, unknown>): string | undefined {
  const summary = asOptionalString(payload.summary)?.trim();
  const text = asOptionalString(payload.text)?.trim();

  if (!summary) {
    return text;
  }

  if (!text) {
    return summary;
  }

  const summaryRefs = extractArtifactRefs(summary);
  const textRefs = extractArtifactRefs(text);

  if (!summaryRefs.size && textRefs.size) {
    return text;
  }

  for (const ref of textRefs) {
    if (!summaryRefs.has(ref)) {
      return text;
    }
  }

  return summary;
}

function extractArtifactRefs(text: string): Set<string> {
  return new Set((text.match(/(?:src|tests?)\/[^\s,;:()]+|README(?:\.md)?|ARCHITECTURE(?:\.md)?|\b[a-z0-9_-]+\.[a-z0-9]+\b/gi) ?? []).map((value) => value.toLowerCase()));
}

function readSecondaryText(payload: Record<string, unknown>): string | undefined {
  return [payload.description, payload.result, payload.output, payload.title]
    .map(asOptionalString)
    .find(Boolean);
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function asPriorityStatusArray(value: unknown): PriorityStatusItem[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return undefined;
      }

      const record = item as Record<string, unknown>;
      const status = record.status;
      const source = record.source;
      const normalizedStatus = status === 'pending' || status === 'active' || status === 'open_loop' || status === 'resolved'
        ? status
        : undefined;
      const normalizedSource = source === 'priority_list' || source === 'summary'
        ? source
        : undefined;
      const text = asOptionalString(record.item)?.trim();

      if (!text || !normalizedStatus || !normalizedSource) {
        return undefined;
      }

      return {
        item: text,
        status: normalizedStatus,
        source: normalizedSource,
      } satisfies PriorityStatusItem;
    })
    .filter((item): item is PriorityStatusItem => Boolean(item));
}

function toRelevantMemoryRef(node: BaseNode): RelevantMemoryRef {
  const payload = node.payload as Partial<MemoryChunkPayload> | undefined;
  return {
    nodeId: node.id,
    layer: payload?.layer ?? 'warm',
    sourceFile: asOptionalString(payload?.sourceFile) ?? 'memory/unknown.md',
    summary: readPrimaryText(node.payload) ?? readSecondaryText(node.payload) ?? node.id,
    score: asOptionalNumber(payload?.connectivity) ?? 0,
    title: asOptionalString(payload?.title),
    routeReason: asOptionalString(payload?.routeReason),
  };
}

function mergeRelevantMemories(values: RelevantMemoryRef[]): RelevantMemoryRef[] {
  const merged = new Map<string, RelevantMemoryRef>();

  for (const value of values) {
    if (!value?.summary) {
      continue;
    }

    const key = `${value.sourceFile}::${normalizeStateText(value.summary)}`;
    const existing = merged.get(key);
    if (!existing || (value.score ?? 0) >= (existing.score ?? 0)) {
      merged.set(key, value);
    }
  }

  return [...merged.values()];
}

function asRelevantMemoryArray(value: unknown): RelevantMemoryRef[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item, index) => {
      if (typeof item === 'string') {
        return {
          nodeId: `summary-memory:${index}`,
          layer: 'warm' as const,
          sourceFile: 'summary',
          summary: item,
          score: 0,
        };
      }

      if (!item || typeof item !== 'object') {
        return undefined;
      }

      const record = item as Record<string, unknown>;
      const layer = record.layer;
      return {
        nodeId: asOptionalString(record.nodeId) ?? `summary-memory:${index}`,
        layer: layer === 'hot' || layer === 'warm' || layer === 'cold' || layer === 'daily_log' || layer === 'memory_core' || layer === 'archive'
          ? layer
          : 'warm',
        sourceFile: asOptionalString(record.sourceFile) ?? 'summary',
        summary: asOptionalString(record.summary) ?? '(memory summary)',
        score: asOptionalNumber(record.score) ?? 0,
        title: asOptionalString(record.title),
        routeReason: asOptionalString(record.routeReason),
      };
    })
    .filter((value): value is RelevantMemoryRef => Boolean(value && value.summary));
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function sanitizeStateText(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const cleaned = value
    .replace(/^\[[^[\]]+\]\s*/u, '')
    .replace(/\s+##\s+(?:Context|Notes|Current Task|Current Plan|Blockers|Next Steps)\b[\s\S]*$/i, '')
    .replace(/\s*<\/final>[\s\S]*$/i, '')
    .replace(/\s+\b(?:Is that still accurate|Or has it moved on|What would you like me to do to verify that)\b[\s\S]*$/i, '')
    .replace(/\r/g, '')
    .replace(/^[\s>*`#-]+/, '')
    .replace(/^\*+\s*/, '')
    .replace(/^[:\-–]+\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned || cleaned.length < 2) {
    return undefined;
  }

  if (looksLikeTransientRuntimeState(cleaned)) {
    return undefined;
  }

  return cleaned;
}

function looksLikeTransientRuntimeState(value: string): boolean {
  const trimmed = value.trim();
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) {
    return false;
  }

  return /"type"\s*:\s*"(thinking|toolcall|tool_call)"/i.test(trimmed)
    || /"thinkingSignature"\s*:/i.test(trimmed)
    || /"arguments"\s*:\s*\{/i.test(trimmed);
}

function looksLikeRecallOnlyOpenLoop(value: string): boolean {
  const normalized = value.toLowerCase();
  return /\bwhat is the current task and the next step\b/.test(normalized)
    || /\basked you to remember\b/.test(normalized)
    || /\bfrom today'?s memory\b/.test(normalized)
    || (/\bcurrent task:\b/.test(normalized) && /\bnext step:\b/.test(normalized))
    || /\bthe context was that\b/.test(normalized);
}
