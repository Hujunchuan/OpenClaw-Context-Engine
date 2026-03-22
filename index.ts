import { OpenClawHypergraphAdapter } from './src/openclaw-adapter.js';

export default function register(api: {
  registerContextEngine: (id: string, factory: () => unknown | Promise<unknown>) => void;
}): void {
  api.registerContextEngine('hypergraph-context-engine', () => {
    const adapter = new OpenClawHypergraphAdapter();

    return {
      info: {
        id: 'hypergraph-context-engine',
        name: 'Hypergraph Context Engine',
        version: '0.1.0',
        ownsCompaction: false,
      },

      async ingest(params: {
        sessionId: string;
        sessionKey?: string;
        message: Record<string, unknown>;
        isHeartbeat?: boolean;
      }) {
        await adapter.ingest({
          sessionId: params.sessionId,
          entry: {
            ...(params.message ?? {}),
            id: String((params.message as { id?: unknown })?.id ?? crypto.randomUUID()),
            createdAt: String((params.message as { createdAt?: unknown })?.createdAt ?? new Date().toISOString()),
          },
        });

        return { ingested: true };
      },

      async ingestBatch(params: {
        sessionId: string;
        sessionKey?: string;
        messages: Array<Record<string, unknown>>;
        isHeartbeat?: boolean;
      }) {
        await adapter.ingestMany({
          sessionId: params.sessionId,
          entries: (params.messages ?? []).map((message) => ({
            ...message,
            id: String((message as { id?: unknown })?.id ?? crypto.randomUUID()),
            createdAt: String((message as { createdAt?: unknown })?.createdAt ?? new Date().toISOString()),
          })),
        });

        return { ingestedCount: params.messages?.length ?? 0 };
      },

      async assemble(params: {
        sessionId: string;
        sessionKey?: string;
        messages: Array<Record<string, unknown>>;
        tokenBudget?: number;
      }) {
        const currentTurnText = extractLatestUserText(params.messages ?? []);
        const result = await adapter.assemble({
          sessionId: params.sessionId,
          currentTurnText,
          tokenBudget: params.tokenBudget ?? 4000,
        });

        return {
          messages: result.messages as Array<Record<string, unknown>>,
          estimatedTokens: estimateTokens(result.messages),
          systemPromptAddition: result.systemPromptAddition,
        };
      },

      async compact(params: {
        sessionId: string;
        sessionKey?: string;
        sessionFile: string;
        tokenBudget?: number;
        force?: boolean;
        currentTokenCount?: number;
        compactionTarget?: 'budget' | 'threshold';
        customInstructions?: string;
        runtimeContext?: Record<string, unknown>;
      }) {
        const result = await adapter.compact({ sessionId: params.sessionId });
        return {
          ok: true,
          compacted: Boolean(result.summaryNodeId),
          result: result.summaryNodeId
            ? {
                summary: `Structured summary emitted: ${result.summaryNodeId}`,
                firstKeptEntryId: undefined,
                tokensBefore: params.currentTokenCount ?? 0,
                tokensAfter: params.currentTokenCount,
                details: result,
              }
            : {
                summary: undefined,
                firstKeptEntryId: undefined,
                tokensBefore: params.currentTokenCount ?? 0,
                tokensAfter: params.currentTokenCount,
                details: result,
              },
        };
      },

      async afterTurn(params: {
        sessionId: string;
        sessionKey?: string;
        sessionFile: string;
        messages: Array<Record<string, unknown>>;
        prePromptMessageCount: number;
        autoCompactionSummary?: string;
        isHeartbeat?: boolean;
        tokenBudget?: number;
        runtimeContext?: Record<string, unknown>;
      }) {
        await adapter.afterTurn({ sessionId: params.sessionId });
      },
    };
  });
}

function extractLatestUserText(messages: Array<Record<string, unknown>>): string | undefined {
  const reversed = [...messages].reverse();
  for (const message of reversed) {
    if ((message.role === 'user' || message.type === 'user') && typeof message.content === 'string') {
      return message.content;
    }
  }
  return undefined;
}

function estimateTokens(messages: Array<Record<string, unknown>>): number {
  const chars = JSON.stringify(messages).length;
  return Math.max(1, Math.ceil(chars / 4));
}
