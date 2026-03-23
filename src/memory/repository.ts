import type { BaseNode, FlushReason, TaskState } from '../../schemas/types.js';
import { indexLayeredMemoryEntries } from './indexer.js';
import { applyLifecyclePolicy } from './lifecycle.js';
import { routeLayeredMemory } from './router.js';
import { LayeredMemoryWorkspaceStore, type StoredMemoryEntry } from './workspace-store.js';

export interface MemoryRepositoryReadParams {
  sessionId: string;
}

export interface MemoryRepositoryFlushParams {
  sessionId: string;
  taskState: TaskState;
  nodes: BaseNode[];
  reason: FlushReason;
}

export interface MemoryRepositoryReadResult {
  entries: StoredMemoryEntry[];
  nodes: BaseNode[];
}

export interface MemoryRepositoryMaintainParams {
  sessionId: string;
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
    const entries = this.store.readEntries();
    return {
      entries,
      nodes: indexLayeredMemoryEntries(params.sessionId, entries),
    };
  }

  flush(params: MemoryRepositoryFlushParams): MemoryRepositoryFlushResult {
    const existingEntries = this.store.readEntries();
    const plan = routeLayeredMemory({
      sessionId: params.sessionId,
      taskState: params.taskState,
      nodes: params.nodes,
      existingEntries,
      reason: params.reason,
    });
    const writeResult = this.store.writeFlush(plan);
    const readResult = this.read({ sessionId: params.sessionId });

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
      ...applyLifecyclePolicy(entry, { now: params.now }),
    }));
    const writeResult = this.store.writeMaintenance({
      entries: maintainedEntries,
      now: params.now,
    });
    const readResult = this.read({ sessionId: params.sessionId });

    return {
      ...readResult,
      writtenFiles: writeResult.writtenFiles,
      notes: ['layered memory maintenance complete'],
    };
  }
}

function isManagedLayerEntry(entry: StoredMemoryEntry): boolean {
  return entry.relativePath.startsWith('memory/hot/')
    || entry.relativePath.startsWith('memory/warm/')
    || entry.relativePath.startsWith('memory/cold/')
    || entry.relativePath.startsWith('memory/archive/');
}
