import {
  CONTEXT_ENGINE_PLUGIN_INFO,
  getOrCreateRuntimeAdapter,
  registerOpenClawHookBridge,
} from './src/plugin/index.js';

type LegacyContextEngineApi = {
  registerContextEngine: (id: string, factory: (runtimeConfig?: unknown) => unknown | Promise<unknown>) => void;
  pluginConfig?: Record<string, unknown>;
};

type HookBridgeApi = {
  on: (hookName: string, handler: (...args: unknown[]) => unknown, opts?: { priority?: number }) => void;
  pluginConfig?: Record<string, unknown>;
  logger?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
    debug?: (message: string) => void;
  };
};

export default function register(api: LegacyContextEngineApi | HookBridgeApi): void {
  if (isLegacyContextEngineApi(api)) {
    registerLegacyContextEngine(api);
    return;
  }

  if (isHookBridgeApi(api)) {
    registerOpenClawHookBridge(api);
    return;
  }

  throw new Error('Unsupported plugin registration API for hypergraph-context-engine.');
}

function registerLegacyContextEngine(api: LegacyContextEngineApi): void {
  api.registerContextEngine(CONTEXT_ENGINE_PLUGIN_INFO.id, (runtimeConfig?: unknown) => {
    const adapter = getOrCreateRuntimeAdapter(mergeRuntimeConfig(api.pluginConfig, runtimeConfig));

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
        await syncRuntimeMessages(adapter, runtimeSessionId, params.messages ?? []);
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
                firstKeptEntryId: result.firstKeptEntryId ?? params.sessionId,
                tokensBefore: result.tokensBefore ?? params.currentTokenCount ?? 0,
                tokensAfter: result.tokensAfter,
                details: result,
              }
            : undefined,
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
        await syncRuntimeMessages(adapter, runtimeSessionId, params.messages ?? []);
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

async function syncRuntimeMessages(
  adapter: Awaited<ReturnType<typeof getOrCreateRuntimeAdapter>>,
  sessionId: string,
  messages: Array<Record<string, unknown>>,
): Promise<void> {
  if (messages.length === 0) {
    return;
  }

  await adapter.syncTranscript({
    sessionId,
    entries: messages.map((message) => ({
      ...message,
      id: String((message as { id?: unknown })?.id ?? crypto.randomUUID()),
      createdAt: String((message as { createdAt?: unknown })?.createdAt ?? new Date().toISOString()),
    })),
  });
}

function isLegacyContextEngineApi(value: LegacyContextEngineApi | HookBridgeApi): value is LegacyContextEngineApi {
  return typeof (value as LegacyContextEngineApi)?.registerContextEngine === 'function';
}

function isHookBridgeApi(value: LegacyContextEngineApi | HookBridgeApi): value is HookBridgeApi {
  return typeof (value as HookBridgeApi)?.on === 'function';
}

function mergeRuntimeConfig(
  pluginConfig: Record<string, unknown> | undefined,
  runtimeConfig: unknown,
): Parameters<typeof getOrCreateRuntimeAdapter>[0] {
  if (!runtimeConfig || typeof runtimeConfig !== 'object') {
    return pluginConfig as Parameters<typeof getOrCreateRuntimeAdapter>[0];
  }

  if (!pluginConfig) {
    return runtimeConfig as Parameters<typeof getOrCreateRuntimeAdapter>[0];
  }

  return {
    ...(pluginConfig as Record<string, unknown>),
    ...(runtimeConfig as Record<string, unknown>),
  } as Parameters<typeof getOrCreateRuntimeAdapter>[0];
}
