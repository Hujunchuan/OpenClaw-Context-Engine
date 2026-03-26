import type {
  BaseNode,
  ContextDetailLevel,
  FlushReason,
  MemoryChunkPayload,
  MemoryNamespaceContext,
  TaskState,
} from '../../schemas/types.js';
import { indexLayeredMemoryEntries } from './indexer.js';
import { applyLifecyclePolicy } from './lifecycle.js';
import { HYPERGRAPH_MEMORY_ROOT } from './router.js';
import { routeLayeredMemory } from './router.js';
import { LayeredMemoryWorkspaceStore, type StoredMemoryEntry } from './workspace-store.js';
import { looksLikeDetailSeekingQuery } from '../core/dialogue-cues.js';

export type MemoryRepositoryReadMode = 'default' | 'session_hot_only' | 'transcript_only';

export interface MemoryRepositoryReadParams extends MemoryNamespaceContext {
  queryGateMode?: MemoryRepositoryReadMode;
  queryText?: string;
  detailLevels?: ContextDetailLevel[];
}

export interface MemoryRepositoryFlushParams extends MemoryNamespaceContext {
  taskState: TaskState;
  nodes: BaseNode[];
  reason: FlushReason;
}

export interface MemoryRepositoryReadResult {
  entries: StoredMemoryEntry[];
  nodes: BaseNode[];
}

export interface MemoryRepositoryMaintainParams extends MemoryNamespaceContext {
  now?: string;
}

export interface MemoryRepositoryFlushResult extends MemoryRepositoryReadResult {
  writtenFiles: string[];
  notes: string[];
}

export interface MemoryRepository {
  read(params: MemoryRepositoryReadParams): MemoryRepositoryReadResult;
  flush(params: MemoryRepositoryFlushParams): MemoryRepositoryFlushResult;
  maintain(params: MemoryRepositoryMaintainParams): MemoryRepositoryFlushResult;
}

export class WorkspaceMemoryRepository implements MemoryRepository {
  private readonly store: LayeredMemoryWorkspaceStore;

  constructor(public readonly rootDir: string) {
    this.store = new LayeredMemoryWorkspaceStore(rootDir);
  }

  read(params: MemoryRepositoryReadParams): MemoryRepositoryReadResult {
    const entries = projectEntriesForRead(filterEntriesForReadMode(this.store.readEntries(), params), params);
    return {
      entries,
      nodes: indexLayeredMemoryEntries(params.sessionId, entries),
    };
  }

  flush(params: MemoryRepositoryFlushParams): MemoryRepositoryFlushResult {
    const existingEntries = this.store.readEntries();
    const plan = routeLayeredMemory({
      sessionId: params.sessionId,
      agentId: params.agentId,
      workspaceId: params.workspaceId,
      taskState: params.taskState,
      nodes: params.nodes,
      existingEntries,
      reason: params.reason,
    });
    const writeResult = this.store.writeFlush(plan);
    const readResult = this.read({
      sessionId: params.sessionId,
      agentId: params.agentId,
      workspaceId: params.workspaceId,
    });

    return {
      ...readResult,
      writtenFiles: writeResult.writtenFiles,
      notes: [`layered memory repository flush complete (${params.reason})`],
    };
  }

  maintain(params: MemoryRepositoryMaintainParams): MemoryRepositoryFlushResult {
    const existingEntries = this.store
      .readEntries()
      .filter((entry) => isManagedLayerEntry(entry));
    if (existingEntries.length === 0) {
      return {
        entries: [],
        nodes: [],
        writtenFiles: [],
        notes: ['layered memory maintenance skipped: no managed entries'],
      };
    }
    const maintainedEntries = existingEntries.map((entry) => ({
      ...entry,
      ...applyLifecyclePolicy(entry, {
        now: params.now,
        namespace: {
          sessionId: entry.lastSessionId,
          agentId: entry.lastAgentId,
          workspaceId: entry.lastWorkspaceId,
        },
      }),
    }));
    const writeResult = this.store.writeMaintenance({
      entries: maintainedEntries,
      now: params.now,
    });
    const readResult = this.read({
      sessionId: params.sessionId,
      agentId: params.agentId,
      workspaceId: params.workspaceId,
    });

    return {
      ...readResult,
      writtenFiles: writeResult.writtenFiles,
      notes: ['layered memory maintenance complete'],
    };
  }
}

function isManagedLayerEntry(entry: StoredMemoryEntry): boolean {
  return entry.relativePath.startsWith(`${HYPERGRAPH_MEMORY_ROOT}/`)
    || entry.relativePath.startsWith('memory/hot/')
    || entry.relativePath.startsWith('memory/warm/')
    || entry.relativePath.startsWith('memory/cold/')
    || entry.relativePath.startsWith('memory/archive/');
}

function filterEntriesForReadMode(
  entries: StoredMemoryEntry[],
  params: MemoryRepositoryReadParams,
): StoredMemoryEntry[] {
  switch (params.queryGateMode) {
    case 'transcript_only':
      return [];
    case 'session_hot_only':
      return entries.filter((entry) => entry.layer === 'hot' && entry.lastSessionId === params.sessionId);
    default:
      return entries;
  }
}

function projectEntriesForRead(
  entries: StoredMemoryEntry[],
  params: MemoryRepositoryReadParams,
): StoredMemoryEntry[] {
  const detailLevels = resolvePreferredDetailLevels(params);

  return entries
    .map((entry) => projectEntryDetail(entry, detailLevels, params.queryText))
    .sort((left, right) => compareProjectedEntryPriority(left, right, params));
}

function resolvePreferredDetailLevels(params: MemoryRepositoryReadParams): ContextDetailLevel[] {
  if (params.detailLevels && params.detailLevels.length > 0) {
    return params.detailLevels;
  }

  if (params.queryGateMode === 'transcript_only') {
    return [];
  }

  if (params.queryGateMode === 'session_hot_only') {
    return ['L0', 'L1'];
  }

  return looksLikeDetailSeekingQuery(params.queryText) ? ['L0', 'L1', 'L2'] : ['L0', 'L1'];
}

function projectEntryDetail(
  entry: StoredMemoryEntry,
  detailLevels: ContextDetailLevel[],
  queryText?: string,
): StoredMemoryEntry {
  const selectedDetailLevel = resolveEntryDetailLevel(entry, detailLevels, queryText);
  const projectedText = resolveProjectedText(entry, selectedDetailLevel);

  return {
    ...entry,
    selectedDetailLevel,
    text: projectedText,
    summary: selectedDetailLevel === 'L0'
      ? entry.abstract
      : selectedDetailLevel === 'L1'
        ? entry.overview
        : entry.summary,
  };
}

function resolveEntryDetailLevel(
  entry: StoredMemoryEntry,
  detailLevels: ContextDetailLevel[],
  queryText?: string,
): ContextDetailLevel {
  if (detailLevels.includes('L2') && shouldUseL2(entry, queryText)) {
    return 'L2';
  }

  if (detailLevels.includes('L1')) {
    return 'L1';
  }

  return 'L0';
}

function shouldUseL2(entry: StoredMemoryEntry, queryText?: string): boolean {
  if (!entry.detail?.trim()) {
    return false;
  }

  if (entry.layer === 'hot' && entry.lastSessionId) {
    return true;
  }

  return looksLikeDetailSeekingQuery(queryText);
}

function resolveProjectedText(entry: StoredMemoryEntry, detailLevel: ContextDetailLevel): string {
  switch (detailLevel) {
    case 'L0':
      return entry.abstract;
    case 'L1':
      return entry.overview;
    case 'L2':
      return entry.detail ?? entry.text ?? entry.overview;
    default:
      return entry.overview;
  }
}

function compareProjectedEntryPriority(
  left: StoredMemoryEntry,
  right: StoredMemoryEntry,
  params: MemoryRepositoryReadParams,
): number {
  return namespacePriority(right, params) - namespacePriority(left, params)
    || layerPriority(right.layer) - layerPriority(left.layer)
    || detailPriority(left.selectedDetailLevel as ContextDetailLevel | undefined)
      - detailPriority(right.selectedDetailLevel as ContextDetailLevel | undefined)
    || right.updatedAt.localeCompare(left.updatedAt);
}

function namespacePriority(entry: Pick<MemoryChunkPayload, 'lastSessionId' | 'lastAgentId' | 'lastWorkspaceId'>, params: MemoryRepositoryReadParams): number {
  if (entry.lastSessionId && entry.lastSessionId === params.sessionId) {
    return 4;
  }
  if (entry.lastAgentId && params.agentId && entry.lastAgentId === params.agentId) {
    return 3;
  }
  if (entry.lastWorkspaceId && params.workspaceId && entry.lastWorkspaceId === params.workspaceId) {
    return 2;
  }
  return 1;
}

function layerPriority(layer: StoredMemoryEntry['layer']): number {
  switch (layer) {
    case 'hot':
      return 5;
    case 'warm':
      return 4;
    case 'cold':
    case 'memory_core':
      return 3;
    case 'daily_log':
      return 2;
    case 'archive':
      return 1;
    default:
      return 0;
  }
}

function detailPriority(level: ContextDetailLevel | undefined): number {
  switch (level) {
    case 'L0':
      return 1;
    case 'L1':
      return 2;
    case 'L2':
      return 3;
    default:
      return 2;
  }
}
