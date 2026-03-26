import type { FlushReason, TaskState } from '../../schemas/types.js';
import {
  HypergraphContextEngine,
  type AssembleOutput,
  type HypergraphContextEngineOptions,
  type TranscriptEntryLike,
} from '../core/engine.js';
import type { MemoryRepository } from '../memory/repository.js';
import type { SQLiteStore } from '../core/sqlite-store.js';
import { toRuntimeContextMessage } from './runtime-message-utils.js';

export interface OpenClawAdapterAssembleParams {
  sessionId: string;
  currentTurnText?: string;
  tokenBudget: number;
  agentId?: string;
  workspaceId?: string;
}

export interface OpenClawAdapterAssembleResult {
  messages: Array<Record<string, unknown>>;
  systemPromptAddition?: string;
  debug?: {
    taskState?: TaskState;
    bucketSummary?: Array<{ name: string; count: number; budgetTokens: number }>;
    retrievalSummary?: AssembleOutput['retrievalSummary'];
  };
}

export interface OpenClawAdapterCompactResult {
  summaryNodeId?: string;
  firstKeptEntryId?: string;
  tokensBefore?: number;
  tokensAfter?: number;
  notes?: string[];
}

export interface OpenClawHypergraphAdapterOptions {
  engine?: HypergraphContextEngine;
  sessionStore?: SQLiteStore;
  store?: SQLiteStore;
  memoryRepository?: MemoryRepository;
  memoryWorkspaceRoot?: string;
  enableLayeredRead?: boolean;
  enableLayeredWrite?: boolean;
  enableQueryGate?: boolean;
  disableLongTermMemoryForConversationQueries?: boolean;
  flushOnAfterTurn?: boolean;
  flushOnCompact?: boolean;
  promoteOnMaintenance?: boolean;
  maintenanceMinIntervalMs?: number;
  runtimeIdentityDebug?: boolean;
}

/**
 * Adapter layer between the prototype HypergraphContextEngine and an eventual
 * OpenClaw runtime context-engine contract.
 *
 * This file intentionally does not import OpenClaw runtime internals yet.
 * It only defines the translation boundary we expect to implement when wiring
 * the plugin into the real runtime.
 */
export class OpenClawHypergraphAdapter {
  private readonly engine: HypergraphContextEngine;

  constructor(options: OpenClawHypergraphAdapterOptions = {}) {
    this.engine = options.engine ?? new HypergraphContextEngine(toEngineOptions(options));
  }

  async ingest(params: { sessionId: string; entry: TranscriptEntryLike }): Promise<void> {
    await this.engine.ingest(params.sessionId, normalizeTranscriptEntry(params.entry));
  }

  async ingestMany(params: { sessionId: string; entries: TranscriptEntryLike[] }): Promise<void> {
    for (const entry of params.entries) {
      await this.ingest({ sessionId: params.sessionId, entry });
    }
  }

  async syncTranscript(params: { sessionId: string; entries: TranscriptEntryLike[] }): Promise<{ ingestedCount: number }> {
    return this.engine.syncTranscript(
      params.sessionId,
      params.entries.map((entry) => normalizeTranscriptEntry(entry)),
    );
  }

  async assemble(params: OpenClawAdapterAssembleParams): Promise<OpenClawAdapterAssembleResult> {
    try {
      const output = await this.engine.assemble({
        sessionId: params.sessionId,
        currentTurnText: params.currentTurnText,
        tokenBudget: params.tokenBudget,
        agentId: params.agentId,
        workspaceId: params.workspaceId,
      });

      return {
        messages: output.messages
          .map(toRuntimeContextMessage)
          .filter((message): message is Record<string, unknown> => Boolean(message)),
        systemPromptAddition: output.systemPromptAddition,
        debug: {
          taskState: output.taskState,
          bucketSummary: output.bucketSummary,
          retrievalSummary: output.retrievalSummary,
        },
      };
    } catch (error) {
      return {
        messages: [],
        systemPromptAddition:
          'Hypergraph adapter fallback: assemble failed, so no semantic augmentation was injected.',
        debug: {
          retrievalSummary: [
            {
              nodeId: 'adapter-error',
              kind: 'summary',
              bucket: 'task_state',
              selected: false,
              finalScore: 0,
              graphScore: 0,
              retrievalScore: 0,
              recencyScore: 0,
              utilityScore: 0,
              redundancyPenalty: 0,
            },
          ],
        },
      };
    }
  }

  async compact(params: { sessionId: string; agentId?: string; workspaceId?: string }): Promise<OpenClawAdapterCompactResult> {
    return this.engine.compact(params.sessionId, params);
  }

  async flushMemory(params: {
    sessionId: string;
    reason: FlushReason;
    agentId?: string;
    workspaceId?: string;
  }): Promise<{ writtenFiles: string[]; notes: string[] }> {
    return this.engine.flushMemory(params.sessionId, params.reason, params);
  }

  async afterTurn(params: { sessionId: string; taskState?: TaskState; agentId?: string; workspaceId?: string }): Promise<void> {
    await this.engine.afterTurn(params.sessionId, params.taskState, params);
  }
}

function toEngineOptions(options: OpenClawHypergraphAdapterOptions): HypergraphContextEngineOptions {
  return {
    sessionStore: options.sessionStore ?? options.store,
    memoryRepository: options.memoryRepository,
    memoryWorkspaceRoot: options.memoryWorkspaceRoot,
    enableLayeredRead: options.enableLayeredRead,
    enableLayeredWrite: options.enableLayeredWrite,
    enableQueryGate: options.enableQueryGate,
    disableLongTermMemoryForConversationQueries: options.disableLongTermMemoryForConversationQueries,
    flushOnAfterTurn: options.flushOnAfterTurn,
    flushOnCompact: options.flushOnCompact,
    promoteOnMaintenance: options.promoteOnMaintenance,
    maintenanceMinIntervalMs: options.maintenanceMinIntervalMs,
    runtimeIdentityDebug: options.runtimeIdentityDebug,
  };
}

function normalizeTranscriptEntry(entry: TranscriptEntryLike): TranscriptEntryLike {
  return {
    ...entry,
    createdAt: entry.createdAt ?? new Date().toISOString(),
  };
}

