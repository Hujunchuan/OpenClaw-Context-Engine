import type { TaskState } from '../schemas/types.js';
import {
  HypergraphContextEngine,
  type AssembleOutput,
  type TranscriptEntryLike,
} from './engine.js';
import type { SQLiteStore } from './sqlite-store.js';

export interface OpenClawAdapterAssembleParams {
  sessionId: string;
  currentTurnText?: string;
  tokenBudget: number;
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
  notes?: string[];
}

export interface OpenClawHypergraphAdapterOptions {
  engine?: HypergraphContextEngine;
  store?: SQLiteStore;
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
    this.engine = options.engine ?? new HypergraphContextEngine({ store: options.store });
  }

  async ingest(params: { sessionId: string; entry: TranscriptEntryLike }): Promise<void> {
    await this.engine.ingest(params.sessionId, normalizeTranscriptEntry(params.entry));
  }

  async ingestMany(params: { sessionId: string; entries: TranscriptEntryLike[] }): Promise<void> {
    for (const entry of params.entries) {
      await this.ingest({ sessionId: params.sessionId, entry });
    }
  }

  async assemble(params: OpenClawAdapterAssembleParams): Promise<OpenClawAdapterAssembleResult> {
    try {
      const output = await this.engine.assemble({
        sessionId: params.sessionId,
        currentTurnText: params.currentTurnText,
        tokenBudget: params.tokenBudget,
      });

      return {
        messages: output.messages.map(toRuntimeContextMessage),
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

  async compact(params: { sessionId: string }): Promise<OpenClawAdapterCompactResult> {
    return this.engine.compact(params.sessionId);
  }

  async afterTurn(params: { sessionId: string; taskState?: TaskState }): Promise<void> {
    await this.engine.afterTurn(params.sessionId, params.taskState);
  }
}

function normalizeTranscriptEntry(entry: TranscriptEntryLike): TranscriptEntryLike {
  return {
    ...entry,
    createdAt: entry.createdAt ?? new Date().toISOString(),
  };
}

function toRuntimeContextMessage(message: Record<string, unknown>): Record<string, unknown> {
  return {
    ...message,
    source: 'hypergraph-context-engine',
  };
}
