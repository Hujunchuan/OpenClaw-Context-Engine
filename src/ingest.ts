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
const OPEN_LOOP_PATTERNS = [/\?$/, /todo/i, /follow up/i, /next step/i, /待处理/g, /后续/g];
const ARTIFACT_PATTERNS = [/src\//i, /README/i, /fixture/i, /demo/i, /test/i];

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

  if (matchesAny(CONSTRAINT_PATTERNS, normalizedText)) {
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

  if (matchesAny(DECISION_PATTERNS, normalizedText) || (entry.role === 'assistant' && /implemented|added|created/i.test(normalizedText))) {
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
        status: /maybe|could|candidate/i.test(normalizedText) ? 'candidate' : 'active',
      },
    });
  }

  if (matchesAny(OPEN_LOOP_PATTERNS, normalizedText)) {
    nodes.push({
      id: `${transcriptId}:open-loop`,
      kind: 'open_loop',
      sessionId,
      transcriptId,
      parentTranscriptId: entry.parentId,
      createdAt,
      tags: ['open-loop'],
      payload: {
        question: normalizedText,
        text: normalizedText,
      },
    });
  }

  if (matchesAny(ARTIFACT_PATTERNS, normalizedText)) {
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

    if (node.kind === 'decision' && latestOpenLoop && (textsLookRelated(node, latestOpenLoop) || node.transcriptId?.startsWith('a'))) {
      edges.push({
        id: `${node.id}->${latestOpenLoop.id}`,
        kind: 'resolves',
        from: node.id,
        to: latestOpenLoop.id,
        createdAt,
        reason: textsLookRelated(node, latestOpenLoop)
          ? 'Heuristic: decision appears to address the latest open loop'
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

function inferTags(entry: TranscriptEntryLike, text: string): string[] {
  const tags = new Set<string>();

  if (entry.role) {
    tags.add(entry.role);
  }

  if (matchesAny(CONSTRAINT_PATTERNS, text)) {
    tags.add('constraintish');
  }

  if (matchesAny(OPEN_LOOP_PATTERNS, text)) {
    tags.add('open-loopish');
  }

  return [...tags];
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

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
