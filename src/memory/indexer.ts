import type { BaseNode, MemoryChunkPayload } from '../../schemas/types.js';
import type { StoredMemoryEntry } from './workspace-store.js';

export function indexLayeredMemoryEntries(sessionId: string, entries: StoredMemoryEntry[]): BaseNode[] {
  return entries.map((entry) => toMemoryChunkNode(sessionId, entry));
}

export function toMemoryChunkNode(sessionId: string, entry: StoredMemoryEntry): BaseNode {
  const payload: MemoryChunkPayload = {
    layer: entry.layer,
    scope: entry.scope,
    sourceFile: entry.relativePath,
    title: entry.title,
    summary: entry.summary,
    abstract: entry.abstract,
    overview: entry.overview,
    detail: entry.detail,
    text: entry.text,
    category: entry.category,
    routeReason: entry.routeReason,
    dedupeKey: entry.dedupeKey,
    persistence: entry.persistence,
    recurrence: entry.recurrence,
    connectivity: entry.connectivity,
    activationEnergy: entry.activationEnergy,
    status: entry.status,
    updatedAt: entry.updatedAt,
    firstSeenAt: entry.firstSeenAt,
    hitCount: entry.hitCount,
    sessionCount: entry.sessionCount,
    lastSessionId: entry.lastSessionId,
    lastAgentId: entry.lastAgentId,
    lastWorkspaceId: entry.lastWorkspaceId,
  };

  return {
    id: createMemoryNodeId(entry.relativePath),
    kind: 'memory_chunk',
    sessionId,
    createdAt: entry.updatedAt,
    tags: ['memory', entry.layer, entry.scope],
    payload: payload as unknown as Record<string, unknown>,
  };
}

export function createMemoryNodeId(relativePath: string): string {
  return `memory:${relativePath.replace(/\\/g, '/')}`;
}
