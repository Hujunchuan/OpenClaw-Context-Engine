import type { BaseNode, GraphEdge } from '../schemas/types.js';
import type { TranscriptEntryLike } from './engine.js';
import { materializeTaskState } from './task-state.js';

export interface SessionSnapshot {
  sessionId: string;
  transcriptEntries: TranscriptEntryLike[];
  nodes: BaseNode[];
  edges: GraphEdge[];
}

export interface InMemoryEngineState {
  sessions: Map<string, SessionSnapshot>;
}

export interface IngestResult {
  snapshot: SessionSnapshot;
  createdNodes: BaseNode[];
  createdEdges: GraphEdge[];
}

const CONSTRAINT_PATTERNS = [/\bmust\b/i, /\bshould\b/i, /\bneed to\b/i, /不要/g, /必须/g, /优先/g];
const DECISION_PATTERNS = [/\bwe will\b/i, /\bI('?| wi)ll\b/i, /决定/g, /采用/g, /先做/g];
const TOOL_RESULT_DECISION_PATTERNS = [/^commit\s+[0-9a-f]{7,}\b/im, /^[0-9a-f]{7,}\s+\S+/m, /\bTo\s+.+github/im, /Everything up-to-date/im, /npm run demo(?::snapshots)?/i, /summary created for/i];
const OPEN_LOOP_PATTERNS = [/\?$/, /todo/i, /follow up/i, /next step/i, /待处理/g, /后续/g];
const RESOLUTION_PATTERNS = [/\b(done|fixed|resolved|completed|finished|closed|shipped)\b/i, /已完成/g, /完成了/g, /解决了/g, /关闭了/g];
const ARTIFACT_PATTERNS = [
  /src\//i,
  /README(?:\.md)?/i,
  /ARCHITECTURE(?:\.md)?/i,
  /fixture/i,
  /demo/i,
  /tests?\//i,
  /\btest(?:s)?\b/i,
  /sqlite-store/i,
  /schema/i,
  /\.[a-z0-9]+\b/i,
];
const ARTIFACT_ACTION_PATTERNS = [/\b(add|added|update|updated|wire|wired|implement|implemented|create|created|prepare|prepared|write|wrote|persist|persisted|read|reading)\b/i, /添加|更新|实现|创建|准备|写入|持久化|读取/g];
const CONCRETE_ARTIFACT_CUES = [/src\//i, /tests?\//i, /README(?:\.md)?/i, /ARCHITECTURE(?:\.md)?/i, /\bfixture(?:s)?\b/i, /\bdemo\b/i, /\btest(?:s)?\b/i, /\bsnapshot(?:s)?\b/i, /\bmodule\b/i, /\bschema\b/i, /\.[a-z0-9]+\b/i];

export function createInMemoryEngineState(): InMemoryEngineState {
  return {
    sessions: new Map<string, SessionSnapshot>(),
  };
}

export function ingestTranscriptEntry(
  state: InMemoryEngineState,
  sessionId: string,
  entry: TranscriptEntryLike,
): IngestResult {
  const snapshot = getOrCreateSessionSnapshot(state, sessionId);
  snapshot.transcriptEntries.push(entry);

  const createdNodes = extractNodes(sessionId, entry);
  const createdEdges = linkNodes(snapshot, createdNodes, entry);

  snapshot.nodes.push(...createdNodes);
  snapshot.edges.push(...createdEdges);

  // materialize eagerly so callers can cheaply inspect the cache through state snapshots if needed.
  materializeTaskState(sessionId, snapshot.nodes, snapshot.edges);

  return { snapshot, createdNodes, createdEdges };
}

export function extractNodes(sessionId: string, entry: TranscriptEntryLike): BaseNode[] {
  const createdAt = entry.createdAt ?? new Date().toISOString();
  const transcriptId = entry.id;
  const baseText = normalizeContentToText(entry.content);
  const normalizedText = baseText.trim();
  const semanticText = extractSemanticStatusText(normalizedText);
  const toolResultDecisionSummary = entry.type === 'tool_result'
    ? inferToolResultDecisionSummary(normalizedText)
    : undefined;
  const nodes: BaseNode[] = [];

  nodes.push({
    id: `${transcriptId}:message`,
    kind: inferMessageKind(entry),
    sessionId,
    transcriptId,
    parentTranscriptId: entry.parentId,
    createdAt,
    tags: inferTags(entry, normalizedText),
    payload: {
      role: entry.role,
      type: entry.type,
      text: normalizedText,
    },
  });

  if (entry.role === 'user' && normalizedText) {
    nodes.push({
      id: `${transcriptId}:intent`,
      kind: 'intent',
      sessionId,
      transcriptId,
      parentTranscriptId: entry.parentId,
      createdAt,
      tags: ['intent'],
      payload: {
        intent: normalizedText,
        text: normalizedText,
      },
    });
  }

  if (shouldCreateConstraintNode(entry, normalizedText)) {
    nodes.push({
      id: `${transcriptId}:constraint`,
      kind: 'constraint',
      sessionId,
      transcriptId,
      parentTranscriptId: entry.parentId,
      createdAt,
      tags: ['constraint'],
      payload: {
        text: normalizedText,
      },
    });
  }

  const decisionSummary = toolResultDecisionSummary ?? semanticText;
  if (
    decisionSummary
    && (
      matchesAny(DECISION_PATTERNS, decisionSummary)
      || Boolean(toolResultDecisionSummary)
      || matchesAny(TOOL_RESULT_DECISION_PATTERNS, normalizedText)
      || (entry.role === 'assistant' && (/implemented|added|created/i.test(decisionSummary) || matchesAny(RESOLUTION_PATTERNS, decisionSummary)))
    )
  ) {
    nodes.push({
      id: `${transcriptId}:decision`,
      kind: 'decision',
      sessionId,
      transcriptId,
      parentTranscriptId: entry.parentId,
      createdAt,
      tags: ['decision'],
      payload: {
        text: normalizedText,
        summary: decisionSummary,
        status: /maybe|could|candidate/i.test(decisionSummary) ? 'candidate' : 'active',
      },
    });
  }

  const openLoopText = extractOpenLoopText(normalizedText);
  if (openLoopText && !looksLikePriorityList(normalizedText)) {
    nodes.push({
      id: `${transcriptId}:open-loop`,
      kind: 'open_loop',
      sessionId,
      transcriptId,
      parentTranscriptId: entry.parentId,
      createdAt,
      tags: ['open-loop'],
      payload: {
        question: openLoopText,
        text: openLoopText,
      },
    });
  }

  if (semanticText && shouldCreateArtifactNode(entry, normalizedText)) {
    nodes.push({
      id: `${transcriptId}:artifact`,
      kind: 'artifact_snapshot',
      sessionId,
      transcriptId,
      parentTranscriptId: entry.parentId,
      createdAt,
      tags: ['artifact'],
      payload: {
        text: normalizedText,
        summary: semanticText,
      },
    });
  }

  if (entry.type === 'tool_call') {
    nodes.push({
      id: `${transcriptId}:tool-call`,
      kind: 'tool_call',
      sessionId,
      transcriptId,
      parentTranscriptId: entry.parentId,
      createdAt,
      tags: ['tool'],
      payload: {
        toolName: asOptionalString((entry as Record<string, unknown>).toolName) ?? 'unknown-tool',
        text: normalizedText || 'tool call',
      },
    });
  }

  if (entry.type === 'tool_result') {
    nodes.push({
      id: `${transcriptId}:tool-result`,
      kind: 'tool_result',
      sessionId,
      transcriptId,
      parentTranscriptId: entry.parentId,
      createdAt,
      tags: ['tool-result'],
      payload: {
        toolName: asOptionalString((entry as Record<string, unknown>).toolName) ?? 'unknown-tool',
        result: normalizedText,
        text: normalizedText,
      },
    });
  }

  return nodes;
}

function getOrCreateSessionSnapshot(state: InMemoryEngineState, sessionId: string): SessionSnapshot {
  const existing = state.sessions.get(sessionId);
  if (existing) {
    return existing;
  }

  const created: SessionSnapshot = {
    sessionId,
    transcriptEntries: [],
    nodes: [],
    edges: [],
  };

  state.sessions.set(sessionId, created);
  return created;
}

function linkNodes(snapshot: SessionSnapshot, createdNodes: BaseNode[], entry: TranscriptEntryLike): GraphEdge[] {
  const createdAt = entry.createdAt ?? new Date().toISOString();
  const edges: GraphEdge[] = [];
  const existingNodes = [...snapshot.nodes];
  const latestExistingMessage = existingNodes.reverse().find((node) => node.kind === 'message');
  const explicitParentMessage = entry.parentId
    ? snapshot.nodes.find((node) => node.kind === 'message' && node.transcriptId === entry.parentId)
    : undefined;
  const parentMessage = explicitParentMessage ?? latestExistingMessage;
  const latestOpenLoop = findLatestNodeOfKind(snapshot.nodes, 'open_loop');
  const latestResolvedOpenLoop = findLatestResolvedOpenLoop(snapshot.nodes, snapshot.edges);
  const latestDecision = findLatestNodeOfKind(snapshot.nodes, 'decision');
  const latestArtifact = findLatestNodeOfKind(snapshot.nodes, 'artifact_snapshot');
  const latestToolResult = findLatestNodeOfKind(snapshot.nodes, 'tool_result');

  for (const node of createdNodes) {
    if (node.id !== createdNodes[0]?.id && createdNodes[0]) {
      edges.push({
        id: `${node.id}->${createdNodes[0].id}`,
        kind: 'derived_from',
        from: node.id,
        to: createdNodes[0].id,
        createdAt,
        reason: 'Extracted semantic node from transcript entry',
      });
    }

    if (parentMessage && node.kind === 'message') {
      edges.push({
        id: `${node.id}->${parentMessage.id}`,
        kind: 'responds_to',
        from: node.id,
        to: parentMessage.id,
        createdAt,
        reason: explicitParentMessage ? 'Explicit transcript parent' : 'Latest prior message fallback',
      });
    }

    if (node.kind === 'decision' && latestOpenLoop && shouldResolveOpenLoop(node, latestOpenLoop)) {
      const directlyRelated = textsLookRelated(node, latestOpenLoop);
      const explicitResolution = hasResolutionCue(node);

      edges.push({
        id: `${node.id}->${latestOpenLoop.id}`,
        kind: 'resolves',
        from: node.id,
        to: latestOpenLoop.id,
        createdAt,
        reason: directlyRelated
          ? explicitResolution
            ? 'Heuristic: decision explicitly marks the latest related open loop as resolved'
            : 'Heuristic: decision appears to address the latest open loop'
          : 'Heuristic fallback: latest assistant decision tentatively resolves the latest open loop',
      });
    }

    if (node.kind === 'decision' && latestDecision && textsLookRelated(node, latestDecision)) {
      edges.push({
        id: `${node.id}->${latestDecision.id}`,
        kind: 'supersedes',
        from: node.id,
        to: latestDecision.id,
        createdAt,
        reason: 'Heuristic: newer decision overlaps with a prior decision',
      });
    }

    if (node.kind === 'open_loop' && latestResolvedOpenLoop && textsLookRelated(node, latestResolvedOpenLoop)) {
      edges.push({
        id: `${node.id}->${latestResolvedOpenLoop.id}`,
        kind: 'invalidates',
        from: node.id,
        to: latestResolvedOpenLoop.id,
        createdAt,
        reason: 'Heuristic: a new related open loop reopens a previously resolved follow-up',
      });
    }

    if (node.kind === 'artifact_snapshot') {
      const dependencyTarget = latestDecision ?? latestToolResult;
      if (dependencyTarget) {
        edges.push({
          id: `${node.id}->${dependencyTarget.id}`,
          kind: 'depends_on',
          from: node.id,
          to: dependencyTarget.id,
          createdAt,
          reason: 'Heuristic: artifact snapshot likely depends on the most recent implementation step',
        });
      }
    }

    if (node.kind === 'tool_result' && latestArtifact && textsLookRelated(node, latestArtifact)) {
      edges.push({
        id: `${node.id}->${latestArtifact.id}`,
        kind: 'depends_on',
        from: node.id,
        to: latestArtifact.id,
        createdAt,
        reason: 'Heuristic: tool result references the current artifact state',
      });
    }
  }

  return dedupeEdges(edges);
}

function findLatestNodeOfKind(nodes: BaseNode[], kind: BaseNode['kind']): BaseNode | undefined {
  return [...nodes].reverse().find((node) => node.kind === kind);
}

function findLatestResolvedOpenLoop(nodes: BaseNode[], edges: GraphEdge[]): BaseNode | undefined {
  const resolvedIds = new Set(edges.filter((edge) => edge.kind === 'resolves').map((edge) => edge.to));
  return [...nodes].reverse().find((node) => node.kind === 'open_loop' && resolvedIds.has(node.id));
}

function textsLookRelated(left: BaseNode, right: BaseNode): boolean {
  const leftTokens = tokenizeNode(left);
  const rightTokens = tokenizeNode(right);

  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return false;
  }

  const shared: string[] = [];
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      shared.push(token);
    }
  }

  if (shared.length >= 2) {
    return true;
  }

  return shared.some((token) => token.length >= 6 || token.includes('sqlite') || token.includes('fixture') || token.includes('golden'));
}

function shouldResolveOpenLoop(node: BaseNode, openLoop: BaseNode): boolean {
  if (textsLookRelated(node, openLoop)) {
    return true;
  }

  return hasResolutionCue(node) && Boolean(node.transcriptId?.startsWith('a'));
}

function hasResolutionCue(node: BaseNode): boolean {
  return matchesAny(RESOLUTION_PATTERNS, normalizeContentToText(node.payload));
}

function tokenizeNode(node: BaseNode): Set<string> {
  const text = normalizeContentToText(node.payload).toLowerCase();
  const tokens = text
    .split(/[^\p{L}\p{N}_/.-]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);

  return new Set(tokens);
}

function dedupeEdges(edges: GraphEdge[]): GraphEdge[] {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    const key = `${edge.kind}:${edge.from}:${edge.to}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function inferMessageKind(entry: TranscriptEntryLike): BaseNode['kind'] {
  if (entry.type === 'tool_call') {
    return 'tool_call';
  }

  if (entry.type === 'tool_result') {
    return 'tool_result';
  }

  return 'message';
}

function shouldCreateConstraintNode(entry: TranscriptEntryLike, text: string): boolean {
  if (!matchesAny(CONSTRAINT_PATTERNS, text)) {
    return false;
  }

  if (entry.role === 'assistant' || entry.type === 'tool_result') {
    return true;
  }

  const normalized = text.toLowerCase();
  const hasPriorityList = /\b(priority|plan|todo|goal|mvp)\b/i.test(text) || /优先\s*[:：]?\s*\d/.test(text);
  const hasConcreteConstraintCue = /\b(keep|preserve|avoid|don't|do not|without|limit|only|exactly|required)\b/i.test(text)
    || /保持|保留|避免|不要|仅|只|限制/.test(text);

  if (entry.role === 'user' && hasPriorityList && !hasConcreteConstraintCue) {
    return false;
  }

  return true;
}

function shouldCreateArtifactNode(entry: TranscriptEntryLike, text: string): boolean {
  const hasArtifactSignal = matchesAny(ARTIFACT_PATTERNS, text);
  const hasConcreteArtifactCue = matchesAny(CONCRETE_ARTIFACT_CUES, text);

  if (!hasArtifactSignal || !hasConcreteArtifactCue) {
    return false;
  }

  if (entry.type === 'tool_call' || entry.type === 'tool_result') {
    return true;
  }

  if (entry.role === 'user') {
    const hasPriorityList = /\b(priority|plan|todo|goal|mvp)\b/i.test(text) || /优先\s*[:：]?\s*\d/.test(text);
    if (hasPriorityList) {
      return false;
    }

    return /src\//i.test(text) || /tests?\//i.test(text) || /README(?:\.md)?/i.test(text) || /ARCHITECTURE(?:\.md)?/i.test(text) || /\.[a-z0-9]+\b/i.test(text);
  }

  if (entry.role === 'assistant' && (matchesAny(ARTIFACT_ACTION_PATTERNS, text) || text.toLowerCase().includes('next step:'))) {
    return true;
  }

  return /\b(file|files|snapshot|module|fixture|demo|test|readme|architecture|schema)\b/i.test(text)
    && /\b(add|update|wire|implement|create|prepare|write|read|touch|edit|change)\b/i.test(text);
}

function inferTags(entry: TranscriptEntryLike, text: string): string[] {
  const tags = new Set<string>();

  if (entry.role) {
    tags.add(entry.role);
  }

  if (matchesAny(CONSTRAINT_PATTERNS, text)) {
    tags.add('constraintish');
  }

  if (matchesAny(OPEN_LOOP_PATTERNS, text) && !looksLikePriorityList(text)) {
    tags.add('open-loopish');
  }

  if (looksLikePriorityList(text)) {
    tags.add('priority-list');
  }

  return [...tags];
}

function extractSemanticStatusText(text: string): string {
  const normalized = text.trim();
  if (!normalized) {
    return normalized;
  }

  const cutIndex = normalized.search(/\b(?:next step|todo|follow up|follow-up|blocked on|pending)\b\s*[:：-]/i);
  if (cutIndex <= 0) {
    return normalized;
  }

  return normalized.slice(0, cutIndex).trim().replace(/[\s.]+$/g, '').trim();
}

function inferToolResultDecisionSummary(text: string): string | undefined {
  const normalized = text.trim();
  if (!normalized) {
    return undefined;
  }

  const commitLine = normalized.match(/^(?:commit\s+)?([0-9a-f]{7,})\s+(.+)$/im);
  if (commitLine) {
    return `Committed changes: ${commitLine[2]?.trim()}`;
  }

  if ((/(?:^|\n)To\s+.+$/im.test(normalized) && /github/i.test(normalized)) || /Everything up-to-date/im.test(normalized)) {
    return 'Pushed changes to GitHub';
  }

  if (/npm run demo:snapshots/i.test(normalized) || /=== SCENARIO:/i.test(normalized)) {
    return 'Ran toy demo fixtures';
  }

  if (/summary created for/i.test(normalized) || /open loops kept:/i.test(normalized) || /pruned\s+\d+\s+older raw nodes/i.test(normalized)) {
    return 'Ran minimal compact session snapshot';
  }

  return undefined;
}

function normalizeContentToText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content.map(normalizeContentToText).filter(Boolean).join('\n');
  }

  if (content && typeof content === 'object') {
    const text = asOptionalString((content as Record<string, unknown>).text);
    if (text) {
      return text;
    }

    return JSON.stringify(content);
  }

  return '';
}

function matchesAny(patterns: RegExp[], text: string): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function extractOpenLoopText(text: string): string | undefined {
  if (!matchesAny(OPEN_LOOP_PATTERNS, text)) {
    return undefined;
  }

  const trailingQuestionMatch = text.match(/([^.!?。！？]*\?)$/);
  const cueMatches = [...text.matchAll(/\b(?:next step|todo|follow up|follow-up|blocked on|pending)\b\s*[:：-]/gi)];
  const lastCue = cueMatches.at(-1);
  const extracted = lastCue
    ? text.slice((lastCue.index ?? 0) + lastCue[0].length)
    : trailingQuestionMatch?.[1] ?? text;
  const normalized = extracted.trim();

  return normalized || undefined;
}

function looksLikePriorityList(text: string): boolean {
  return (/(\bpriority|priorities|order|todo|next steps?)\b/i.test(text) || /优先顺序|优先级|待办/.test(text))
    && /\d+[.)]\s*/.test(text);
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
