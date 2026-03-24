import type { BaseNode, FlushReason, MemoryNamespaceContext, TaskState } from '../../schemas/types.js';
import { indexLayeredMemoryEntries } from './indexer.js';
import { applyLifecyclePolicy } from './lifecycle.js';
import { HYPERGRAPH_MEMORY_ROOT } from './router.js';
import { routeLayeredMemory } from './router.js';
import { LayeredMemoryWorkspaceStore, type StoredMemoryEntry } from './workspace-store.js';

export type MemoryRepositoryReadMode = 'default' | 'session_hot_only' | 'transcript_only';

export interface MemoryRepositoryReadParams extends MemoryNamespaceContext {
  queryGateMode?: MemoryRepositoryReadMode;
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
    const entries = filterEntriesForReadMode(this.store.readEntries(), params);
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
