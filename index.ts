import {
  CONTEXT_ENGINE_PLUGIN_INFO,
  getOrCreateRuntimeAdapter,
  normalizeContextEngineConfig,
  registerOpenClawHookBridge,
} from './src/plugin/index.js';
import {
  extractLatestUserTextFromRuntimeMessages,
  selectSafeRuntimeMessages,
  shouldSyncRuntimeMessage,
} from './src/plugin/runtime-message-utils.js';
import {
  rememberRuntimeIdentityObservation,
  resolveCanonicalRuntimeIdentity,
  writeRuntimeIdentityDiagnostic,
} from './src/plugin/runtime-identity.js';

type LegacyContextEngineApi = {
  registerContextEngine: (id: string, factory: (runtimeConfig?: unknown) => unknown | Promise<unknown>) => void;
  pluginConfig?: Record<string, unknown>;
  config?: {
    plugins?: {
      slots?: {
        contextEngine?: unknown;
      };
    };
  };
};

type HookBridgeApi = {
  on: (hookName: string, handler: (...args: unknown[]) => unknown, opts?: { priority?: number }) => void;
  pluginConfig?: Record<string, unknown>;
  config?: {
    plugins?: {
      slots?: {
        contextEngine?: unknown;
      };
    };
  };
  logger?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
    debug?: (message: string) => void;
  };
};

export default function register(api: LegacyContextEngineApi | HookBridgeApi): void {
  let registered = false;
  const hasLegacyApi = isLegacyContextEngineApi(api);
  const slotSelectedForPlugin = isContextEngineSlotSelected(api);

  if (hasLegacyApi) {
    registerLegacyContextEngine(api);
    registered = true;
  }

  if (isHookBridgeApi(api) && (!hasLegacyApi || !slotSelectedForPlugin)) {
    registerOpenClawHookBridge(api);
    registered = true;
  }

  if (!registered) {
    throw new Error('Unsupported plugin registration API for hypergraph-context-engine.');
  }
}

function registerLegacyContextEngine(api: LegacyContextEngineApi): void {
  api.registerContextEngine(CONTEXT_ENGINE_PLUGIN_INFO.id, (runtimeConfig?: unknown) => {
    const resolvedConfig = normalizeContextEngineConfig(mergeRuntimeConfig(api.pluginConfig, runtimeConfig));
    const adapter = getOrCreateRuntimeAdapter(resolvedConfig);

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
        const identity = resolveCanonicalRuntimeIdentity(params as Record<string, unknown>);
        writeRuntimeIdentityDiagnostic({
          enabled: resolvedConfig.runtimeIdentityDebug,
          memoryWorkspaceRoot: resolvedConfig.memoryWorkspaceRoot,
          lifecycle: 'ingest',
          resolution: identity,
        });
        const runtimeSessionId = identity.namespace.sessionId;
        if (!runtimeSessionId) {
          return { ingested: false };
        }
        if (!shouldSyncRuntimeMessage(params.message ?? {})) {
          return { ingested: false };
        }
        rememberRuntimeIdentityObservation({
          namespace: identity.namespace,
          messages: [params.message],
        });

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
        const identity = resolveCanonicalRuntimeIdentity(params as Record<string, unknown>);
        writeRuntimeIdentityDiagnostic({
          enabled: resolvedConfig.runtimeIdentityDebug,
          memoryWorkspaceRoot: resolvedConfig.memoryWorkspaceRoot,
          lifecycle: 'ingestBatch',
          resolution: identity,
        });
        const runtimeSessionId = identity.namespace.sessionId;
        if (!runtimeSessionId) {
          return { ingestedCount: 0 };
        }
        const filteredMessages = (params.messages ?? []).filter(shouldSyncRuntimeMessage);
        rememberRuntimeIdentityObservation({
          namespace: identity.namespace,
          messages: filteredMessages,
        });
        await adapter.ingestMany({
          sessionId: runtimeSessionId,
          entries: filteredMessages.map((message) => ({
            ...message,
            id: String((message as { id?: unknown })?.id ?? crypto.randomUUID()),
            createdAt: String((message as { createdAt?: unknown })?.createdAt ?? new Date().toISOString()),
          })),
        });

        return { ingestedCount: filteredMessages.length };
      },

      async assemble(params: {
        sessionId: string;
        sessionKey?: string;
        messages: Array<Record<string, unknown>>;
        tokenBudget?: number;
      }) {
        const identity = resolveCanonicalRuntimeIdentity(params as Record<string, unknown>);
        writeRuntimeIdentityDiagnostic({
          enabled: resolvedConfig.runtimeIdentityDebug,
          memoryWorkspaceRoot: resolvedConfig.memoryWorkspaceRoot,
          lifecycle: 'assemble',
          resolution: identity,
        });
        const runtimeSessionId = identity.namespace.sessionId;
        if (!runtimeSessionId) {
          return {
            messages: [],
            estimatedTokens: 0,
            systemPromptAddition: 'Hypergraph adapter fallback: missing runtime session identity.',
          };
        }
        const runtimeMessages = (params.messages ?? []).filter(shouldSyncRuntimeMessage);
        rememberRuntimeIdentityObservation({
          namespace: identity.namespace,
          messages: runtimeMessages,
        });
        await syncRuntimeMessages(adapter, runtimeSessionId, runtimeMessages);
        const currentTurnText = extractLatestUserTextFromRuntimeMessages(runtimeMessages);
        const result = await adapter.assemble({
          sessionId: runtimeSessionId,
          currentTurnText,
          tokenBudget: params.tokenBudget ?? 4000,
          agentId: identity.namespace.agentId,
          workspaceId: identity.namespace.workspaceId,
        });
        const slotMessages = runtimeMessages.length > 0
          ? selectSafeRuntimeMessages(runtimeMessages, currentTurnText)
          : result.messages;

        return {
          messages: slotMessages as Array<Record<string, unknown>>,
          estimatedTokens: estimateTokens(slotMessages),
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
        const identity = resolveCanonicalRuntimeIdentity(params as Record<string, unknown>);
        writeRuntimeIdentityDiagnostic({
          enabled: resolvedConfig.runtimeIdentityDebug,
          memoryWorkspaceRoot: resolvedConfig.memoryWorkspaceRoot,
          lifecycle: 'compact',
          resolution: identity,
        });
        const runtimeSessionId = identity.namespace.sessionId;
        if (!runtimeSessionId) {
          return {
            ok: true,
            compacted: false,
          };
        }
        rememberRuntimeIdentityObservation({
          namespace: identity.namespace,
        });
        const result = await adapter.compact({
          sessionId: runtimeSessionId,
          agentId: identity.namespace.agentId,
          workspaceId: identity.namespace.workspaceId,
        });
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
        const identity = resolveCanonicalRuntimeIdentity(params as Record<string, unknown>);
        writeRuntimeIdentityDiagnostic({
          enabled: resolvedConfig.runtimeIdentityDebug,
          memoryWorkspaceRoot: resolvedConfig.memoryWorkspaceRoot,
          lifecycle: 'afterTurn',
          resolution: identity,
        });
        const runtimeSessionId = identity.namespace.sessionId;
        if (!runtimeSessionId) {
          return;
        }
        rememberRuntimeIdentityObservation({
          namespace: identity.namespace,
          messages: params.messages ?? [],
        });
        await syncRuntimeMessages(adapter, runtimeSessionId, params.messages ?? []);
        await adapter.afterTurn({
          sessionId: runtimeSessionId,
          agentId: identity.namespace.agentId,
          workspaceId: identity.namespace.workspaceId,
        });
      },
    };
  });
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
    entries: messages
      .filter(shouldSyncRuntimeMessage)
      .map((message) => ({
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

function isContextEngineSlotSelected(value: LegacyContextEngineApi | HookBridgeApi): boolean {
  const configuredSlot = value.config?.plugins?.slots?.contextEngine;
  return typeof configuredSlot === 'string' && configuredSlot.trim() === CONTEXT_ENGINE_PLUGIN_INFO.id;
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
