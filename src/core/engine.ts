import type { BaseNode, FlushReason, TaskState } from '../../schemas/types.js';
import { assembleContext } from './assemble.js';
import { compactSession } from './compact.js';
import { createInMemoryEngineState, ingestTranscriptEntry } from './ingest.js';
import type { MemoryRepository } from '../memory/repository.js';
import { WorkspaceMemoryRepository } from '../memory/repository.js';
import type { PersistableSessionSnapshot, SQLiteStore } from './sqlite-store.js';
import { materializeTaskState } from './task-state.js';

export interface TranscriptEntryLike {
  id: string;
  parentId?: string;
  role?: string;
  type?: string;
  content?: unknown;
  createdAt?: string;
  [key: string]: unknown;
}

export interface AssembleInput {
  sessionId: string;
  currentTurnText?: string;
  tokenBudget: number;
}

export interface AssembleOutput {
  messages: Array<Record<string, unknown>>;
  systemPromptAddition?: string;
  taskState?: TaskState;
  bucketSummary?: Array<{ name: string; count: number; budgetTokens: number }>;
  retrievalSummary?: Array<{
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
  }>;
}

export interface CompactOutput {
  summaryNodeId?: string;
  notes?: string[];
}

export interface HypergraphContextEngineOptions {
  sessionStore?: SQLiteStore;
  store?: SQLiteStore;
  memoryRepository?: MemoryRepository;
  memoryWorkspaceRoot?: string;
  enableLayeredRead?: boolean;
  enableLayeredWrite?: boolean;
  flushOnAfterTurn?: boolean;
  flushOnCompact?: boolean;
  promoteOnMaintenance?: boolean;
}

export class HypergraphContextEngine {
  private readonly state = createInMemoryEngineState();
  private readonly sessionStore?: SQLiteStore;
  private readonly memoryRepository?: MemoryRepository;
  private readonly enableLayeredRead: boolean;
  private readonly enableLayeredWrite: boolean;
  private readonly flushOnAfterTurn: boolean;
  private readonly flushOnCompact: boolean;
  private readonly promoteOnMaintenance: boolean;

  constructor(options: HypergraphContextEngineOptions = {}) {
    this.sessionStore = options.sessionStore ?? options.store;
    this.memoryRepository = options.memoryRepository ?? (options.memoryWorkspaceRoot ? new WorkspaceMemoryRepository(options.memoryWorkspaceRoot) : undefined);
    this.enableLayeredRead = options.enableLayeredRead ?? Boolean(this.memoryRepository);
    this.enableLayeredWrite = options.enableLayeredWrite ?? Boolean(this.memoryRepository);
    this.flushOnAfterTurn = options.flushOnAfterTurn ?? this.enableLayeredWrite;
    this.flushOnCompact = options.flushOnCompact ?? this.enableLayeredWrite;
    this.promoteOnMaintenance = options.promoteOnMaintenance ?? true;
  }

  async ingest(sessionId: string, entry: TranscriptEntryLike): Promise<void> {
    ingestTranscriptEntry(this.state, sessionId, entry);
    this.persistSession(sessionId);
  }

  async ingestMany(sessionId: string, entries: TranscriptEntryLike[]): Promise<void> {
    for (const entry of entries) {
      ingestTranscriptEntry(this.state, sessionId, entry);
    }

    this.persistSession(sessionId);
  }

  async assemble(input: AssembleInput): Promise<AssembleOutput> {
    const snapshot = this.buildAssembleSnapshot(input.sessionId);
    const result = assembleContext(snapshot, input);

    return {
      messages: result.messages,
      systemPromptAddition: result.systemPromptAddition,
      taskState: result.taskState,
      bucketSummary: result.buckets.map((bucket) => ({
        name: bucket.name,
        count: bucket.nodeIds.length,
        budgetTokens: bucket.budgetTokens,
      })),
      retrievalSummary: result.retrievalSummary,
    };
  }

  async ingestAndAssemble(
    sessionId: string,
    entries: TranscriptEntryLike[],
    input: Omit<AssembleInput, 'sessionId'>,
  ): Promise<AssembleOutput> {
    await this.ingestMany(sessionId, entries);
    return this.assemble({
      sessionId,
      ...input,
    });
  }

  async compact(sessionId: string): Promise<CompactOutput> {
    if (this.flushOnCompact) {
      await this.flushMemory(sessionId, 'compaction');
    }

    const snapshot = this.requireSession(sessionId);
    if (!snapshot) {
      return {
        notes: ['compact skipped: no snapshot for session'],
      };
    }

    const computation = compactSession(snapshot);
    this.state.sessions.set(sessionId, computation.compactedSnapshot as PersistableSessionSnapshot);
    this.persistSession(sessionId);

    return {
      summaryNodeId: computation.summaryNode.id,
      notes: computation.notes,
    };
  }

  async afterTurn(sessionId: string, taskState?: TaskState): Promise<void> {
    if (this.flushOnAfterTurn) {
      await this.flushMemory(sessionId, 'turn_end');
    }

    if (this.promoteOnMaintenance) {
      this.hydrateMemory(sessionId);
    }

    void taskState;
    const snapshot = this.requireSession(sessionId);
    if (!snapshot) {
      return;
    }

    // Placeholder for future async indexing hooks.
    snapshot.transcriptEntries.length = snapshot.transcriptEntries.length;
    this.persistSession(sessionId);
  }

  debugSession(sessionId: string) {
    return this.requireSession(sessionId);
  }

  async flushMemory(sessionId: string, reason: FlushReason): Promise<{ writtenFiles: string[]; notes: string[] }> {
    if (!this.enableLayeredWrite || !this.memoryRepository) {
      return {
        writtenFiles: [],
        notes: ['layered memory write skipped: no workspace configured'],
      };
    }

    const snapshot = this.ensureSession(sessionId);
    const taskState = materializeTaskState(sessionId, snapshot.nodes, snapshot.edges);
    const result = this.memoryRepository.flush({
      sessionId,
      taskState,
      nodes: snapshot.nodes,
      reason,
    });

    return {
      writtenFiles: result.writtenFiles,
      notes: result.notes,
    };
  }

  hydrateMemory(sessionId: string): BaseNode[] {
    if (!this.enableLayeredRead || !this.memoryRepository) {
      return [];
    }

    return this.memoryRepository.read({ sessionId }).nodes;
  }

  private requireSession(sessionId: string): PersistableSessionSnapshot | undefined {
    const inMemory = this.state.sessions.get(sessionId) as PersistableSessionSnapshot | undefined;
    if (inMemory) {
      return this.sanitizeSnapshot(inMemory);
    }

    if (!this.sessionStore) {
      return undefined;
    }

    const restored = this.sessionStore.loadSession(sessionId);
    if (restored) {
      const sanitized = this.sanitizeSnapshot(restored);
      this.state.sessions.set(sessionId, sanitized);
      return sanitized;
    }

    return undefined;
  }

  private persistSession(sessionId: string): void {
    if (!this.sessionStore) {
      return;
    }

    const snapshot = this.state.sessions.get(sessionId) as PersistableSessionSnapshot | undefined;
    if (!snapshot) {
      return;
    }

    const sanitized = this.sanitizeSnapshot(snapshot);
    this.state.sessions.set(sessionId, sanitized);

    this.sessionStore.saveSession({
      ...sanitized,
      taskState: materializeTaskState(sessionId, sanitized.nodes, sanitized.edges),
    });
  }

  private ensureSession(sessionId: string): PersistableSessionSnapshot {
    const existing = this.requireSession(sessionId);
    if (existing) {
      return existing;
    }

    const created: PersistableSessionSnapshot = {
      sessionId,
      transcriptEntries: [],
      nodes: [],
      edges: [],
    };
    this.state.sessions.set(sessionId, created);
    return created;
  }

  private buildAssembleSnapshot(sessionId: string): PersistableSessionSnapshot | undefined {
    const baseSnapshot = this.requireSession(sessionId);
    if (!baseSnapshot) {
      return undefined;
    }

    const memoryNodes = this.hydrateMemory(sessionId);
    if (memoryNodes.length === 0) {
      return baseSnapshot;
    }

    return {
      ...baseSnapshot,
      nodes: [...stripTransientMemoryNodes(baseSnapshot.nodes), ...memoryNodes].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    };
  }

  private sanitizeSnapshot(snapshot: PersistableSessionSnapshot): PersistableSessionSnapshot {
    return {
      ...snapshot,
      nodes: stripTransientMemoryNodes(snapshot.nodes),
    };
  }
}

function stripTransientMemoryNodes(nodes: BaseNode[]): BaseNode[] {
  return nodes.filter((node) => node.kind !== 'memory_chunk');
}
