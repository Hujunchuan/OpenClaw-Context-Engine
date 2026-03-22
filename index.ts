import { CONTEXT_ENGINE_PLUGIN_INFO, getOrCreateRuntimeAdapter } from './src/plugin/index.js';

export default function register(api: {
  registerContextEngine: (id: string, factory: (runtimeConfig?: unknown) => unknown | Promise<unknown>) => void;
}): void {
  api.registerContextEngine(CONTEXT_ENGINE_PLUGIN_INFO.id, (runtimeConfig?: unknown) => {
    const adapter = getOrCreateRuntimeAdapter(runtimeConfig as Parameters<typeof getOrCreateRuntimeAdapter>[0]);

    return {
      info: {
        id: CONTEXT_ENGINE_PLUGIN_INFO.id,
        name: CONTEXT_ENGINE_PLUGIN_INFO.name,
        version: CONTEXT_ENGINE_PLUGIN_INFO.version,
        ownsCompaction: CONTEXT_ENGINE_PLUGIN_INFO.ownsCompaction,
      },

      async ingest(params: {
        sessionId: string;
        sessionKey?: string;
        message: Record<string, unknown>;
        isHeartbeat?: boolean;
      }) {
        const runtimeSessionId = getRuntimeSessionId(params);
        await adapter.ingest({
          sessionId: runtimeSessionId,
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
        const runtimeSessionId = getRuntimeSessionId(params);
        await adapter.ingestMany({
          sessionId: runtimeSessionId,
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
        const runtimeSessionId = getRuntimeSessionId(params);
        const currentTurnText = extractLatestUserText(params.messages ?? []);
        const result = await adapter.assemble({
          sessionId: runtimeSessionId,
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
        const runtimeSessionId = getRuntimeSessionId(params);
        const result = await adapter.compact({ sessionId: runtimeSessionId });
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
        const runtimeSessionId = getRuntimeSessionId(params);
        await adapter.afterTurn({ sessionId: runtimeSessionId });
      },
    };
  });
}

function getRuntimeSessionId(params: { sessionId: string; sessionKey?: string }): string {
  return String(params.sessionKey ?? params.sessionId);
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
