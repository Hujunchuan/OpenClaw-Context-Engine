import type { BaseNode, FlushReason, TaskState } from '../../schemas/types.js';
import { indexLayeredMemoryEntries } from './indexer.js';
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

export interface MemoryRepositoryFlushResult extends MemoryRepositoryReadResult {
  writtenFiles: string[];
  notes: string[];
}

export interface MemoryRepository {
  read(params: MemoryRepositoryReadParams): MemoryRepositoryReadResult;
  flush(params: MemoryRepositoryFlushParams): MemoryRepositoryFlushResult;
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
}
