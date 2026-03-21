import type { TaskState } from '../schemas/types.js';
import { assembleContext } from './assemble.js';
import { compactSession } from './compact.js';
import { createInMemoryEngineState, ingestTranscriptEntry } from './ingest.js';
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
  store?: SQLiteStore;
}

export class HypergraphContextEngine {
  private readonly state = createInMemoryEngineState();
  private readonly store?: SQLiteStore;

  constructor(options: HypergraphContextEngineOptions = {}) {
    this.store = options.store;
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
    const snapshot = this.requireSession(input.sessionId);
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
    const snapshot = this.requireSession(sessionId);
    if (!snapshot) {
      return {
        notes: ['compact skipped: no snapshot for session'],
      };
    }

    const computation = compactSession(snapshot);
    snapshot.nodes.push(computation.summaryNode);
    this.persistSession(sessionId);

    return {
      summaryNodeId: computation.summaryNode.id,
      notes: computation.notes,
    };
  }

  async afterTurn(sessionId: string, taskState?: TaskState): Promise<void> {
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

  private requireSession(sessionId: string): PersistableSessionSnapshot | undefined {
    const inMemory = this.state.sessions.get(sessionId) as PersistableSessionSnapshot | undefined;
    if (inMemory) {
      return inMemory;
    }

    if (!this.store) {
      return undefined;
    }

    const restored = this.store.loadSession(sessionId);
    if (restored) {
      this.state.sessions.set(sessionId, restored);
    }

    return restored;
  }

  private persistSession(sessionId: string): void {
    if (!this.store) {
      return;
    }

    const snapshot = this.state.sessions.get(sessionId) as PersistableSessionSnapshot | undefined;
    if (!snapshot) {
      return;
    }

    this.store.saveSession({
      ...snapshot,
      taskState: materializeTaskState(sessionId, snapshot.nodes, snapshot.edges),
    });
  }
}
