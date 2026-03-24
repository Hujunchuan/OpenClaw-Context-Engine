import type { OpenClawAdapterAssembleResult } from './openclaw-adapter.js';
import {
  CONTEXT_ENGINE_PLUGIN_INFO,
  normalizeContextEngineConfig,
  type ContextEnginePluginConfig,
} from './config.js';
import { getOrCreateRuntimeAdapter } from './runtime-adapter.js';
import {
  extractLatestUserTextFromRuntimeMessages,
  normalizeRuntimeContentToText,
  shouldSyncRuntimeMessage,
} from './runtime-message-utils.js';
import {
  rememberRuntimeIdentityObservation,
  resolveCanonicalRuntimeIdentity,
  writeRuntimeIdentityDiagnostic,
} from './runtime-identity.js';

type HookLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
  debug?: (message: string) => void;
};

type HookApi = {
  on: (hookName: string, handler: (...args: any[]) => unknown, opts?: { priority?: number }) => void;
  pluginConfig?: Record<string, unknown>;
  logger?: HookLogger;
};

type HookMessage = Record<string, unknown> & {
  id: string;
  createdAt: string;
};

type BeforeAgentStartEvent = {
  prompt: string;
  messages?: unknown[];
};

type BeforeAgentStartContext = {
  sessionId?: string;
  agentId?: string;
  sessionKey?: string;
  sessionFile?: string;
  workspaceDir?: string;
  runtimeContext?: Record<string, unknown>;
  messageProvider?: string;
};

type AgentEndEvent = {
  messages: unknown[];
  success: boolean;
};

type AgentHookContext = BeforeAgentStartContext;

type BeforeCompactionEvent = {
  messageCount: number;
  tokenCount?: number;
};

const DEFAULT_TOKEN_BUDGET = 4000;
const MAX_PREPEND_CONTEXT_CHARS = 3600;
const MAX_CONTEXT_ITEMS = 6;

export function registerOpenClawHookBridge(api: HookApi): void {
  const resolvedConfig = normalizeContextEngineConfig(api.pluginConfig as ContextEnginePluginConfig | undefined);
  const adapter = getOrCreateRuntimeAdapter(resolvedConfig);
  const logger = api.logger;

  logger?.info?.(
    `[${CONTEXT_ENGINE_PLUGIN_INFO.id}] OpenClaw hook bridge enabled; using before_agent_start/agent_end/before_compaction fallback.`,
  );

  api.on(
    'before_agent_start',
    async (event: BeforeAgentStartEvent, ctx: BeforeAgentStartContext) => {
      const identity = resolveCanonicalRuntimeIdentity({
        ...ctx,
        prompt: event.prompt,
      });
      writeRuntimeIdentityDiagnostic({
        enabled: resolvedConfig.runtimeIdentityDebug,
        memoryWorkspaceRoot: resolvedConfig.memoryWorkspaceRoot,
        lifecycle: 'hook:before_agent_start',
        resolution: identity,
      });
      const sessionId = identity.namespace.sessionId;
      if (!sessionId) {
        logger?.warn?.(`[${CONTEXT_ENGINE_PLUGIN_INFO.id}] skipped before_agent_start: missing session identity.`);
        return;
      }

      const messages = normalizeHookMessages(event.messages);
      rememberRuntimeIdentityObservation({
        namespace: identity.namespace,
        messages,
      });
      await syncHookMessages(adapter, sessionId, messages);

      const assembled = await adapter.assemble({
        sessionId,
        currentTurnText: extractLatestUserTextFromRuntimeMessages(messages) ?? event.prompt,
        tokenBudget: DEFAULT_TOKEN_BUDGET,
        agentId: identity.namespace.agentId,
        workspaceId: identity.namespace.workspaceId,
      });

      const prependContext = buildHookPrependContext(assembled);
      if (!prependContext) {
        return;
      }

      logger?.debug?.(
        `[${CONTEXT_ENGINE_PLUGIN_INFO.id}] prepended ${prependContext.length} chars of recovered context for ${sessionId}.`,
      );
      return {
        prependContext,
      };
    },
    { priority: 50 },
  );

  api.on(
    'agent_end',
    async (event: AgentEndEvent, ctx: AgentHookContext) => {
      const identity = resolveCanonicalRuntimeIdentity(ctx as Record<string, unknown>);
      writeRuntimeIdentityDiagnostic({
        enabled: resolvedConfig.runtimeIdentityDebug,
        memoryWorkspaceRoot: resolvedConfig.memoryWorkspaceRoot,
        lifecycle: 'hook:agent_end',
        resolution: identity,
      });
      const sessionId = identity.namespace.sessionId;
      if (!sessionId) {
        return;
      }

      const messages = normalizeHookMessages(event.messages);
      rememberRuntimeIdentityObservation({
        namespace: identity.namespace,
        messages,
      });
      await syncHookMessages(adapter, sessionId, messages);
      await adapter.afterTurn({
        sessionId,
        agentId: identity.namespace.agentId,
        workspaceId: identity.namespace.workspaceId,
      });
      logger?.debug?.(
        `[${CONTEXT_ENGINE_PLUGIN_INFO.id}] completed agent_end maintenance for ${sessionId} (success=${event.success}).`,
      );
    },
    { priority: 50 },
  );

  api.on(
    'before_compaction',
    async (_event: BeforeCompactionEvent, ctx: AgentHookContext) => {
      const identity = resolveCanonicalRuntimeIdentity(ctx as Record<string, unknown>);
      writeRuntimeIdentityDiagnostic({
        enabled: resolvedConfig.runtimeIdentityDebug,
        memoryWorkspaceRoot: resolvedConfig.memoryWorkspaceRoot,
        lifecycle: 'hook:before_compaction',
        resolution: identity,
      });
      const sessionId = identity.namespace.sessionId;
      if (!sessionId) {
        return;
      }

      rememberRuntimeIdentityObservation({
        namespace: identity.namespace,
      });
      await adapter.flushMemory({
        sessionId,
        reason: 'compaction',
        agentId: identity.namespace.agentId,
        workspaceId: identity.namespace.workspaceId,
      });
      logger?.debug?.(`[${CONTEXT_ENGINE_PLUGIN_INFO.id}] flushed layered memory before compaction for ${sessionId}.`);
    },
    { priority: 50 },
  );
}

function normalizeHookMessages(messages: unknown[] | undefined): HookMessage[] {
  if (!Array.isArray(messages)) {
    return [];
  }

  return messages
    .filter((message): message is HookMessage => Boolean(message && typeof message === 'object' && !Array.isArray(message)))
    .map((message) => ({
      ...message,
      id: String((message as { id?: unknown }).id ?? crypto.randomUUID()),
      createdAt: String((message as { createdAt?: unknown }).createdAt ?? new Date().toISOString()),
    }));
}

async function syncHookMessages(
  adapter: Awaited<ReturnType<typeof getOrCreateRuntimeAdapter>>,
  sessionId: string,
  messages: HookMessage[],
): Promise<void> {
  if (messages.length === 0) {
    return;
  }

  await adapter.syncTranscript({
    sessionId,
    entries: messages.filter(shouldSyncRuntimeMessage),
  });
}

function buildHookPrependContext(result: OpenClawAdapterAssembleResult): string | undefined {
  const sections: string[] = [];

  if (result.systemPromptAddition?.trim()) {
    sections.push(result.systemPromptAddition.trim());
  }

  const evidenceLines = result.messages
    .slice(0, MAX_CONTEXT_ITEMS)
    .map(formatHookContextMessage)
    .filter(Boolean) as string[];

  if (evidenceLines.length > 0) {
    sections.push(['Recovered context:', ...evidenceLines].join('\n'));
  }

  if (sections.length === 0) {
    return undefined;
  }

  const fullText = ['[Hypergraph Context Bridge]', ...sections].join('\n\n');
  return fullText.length <= MAX_PREPEND_CONTEXT_CHARS
    ? fullText
    : `${fullText.slice(0, MAX_PREPEND_CONTEXT_CHARS - 3)}...`;
}

function formatHookContextMessage(message: Record<string, unknown>): string | undefined {
  const role = typeof message.role === 'string' ? message.role : undefined;
  const kind = typeof message.kind === 'string' ? message.kind : role ?? 'context';
  const content = message.content;

  if (role) {
    const text = normalizeRuntimeContentToText(content);
    if (text) {
      return `- ${role}: ${truncateInline(text, 280)}`;
    }
  }

  if (content && typeof content === 'object' && !Array.isArray(content)) {
    const typedContent = content as {
      title?: unknown;
      summary?: unknown;
      layer?: unknown;
      sourceFile?: unknown;
    };
    const title = typeof typedContent.title === 'string' ? typedContent.title.trim() : '';
    const summary = typeof typedContent.summary === 'string' ? typedContent.summary.trim() : '';
    const layer = typeof typedContent.layer === 'string' ? typedContent.layer.trim() : '';
    const sourceFile = typeof typedContent.sourceFile === 'string' ? typedContent.sourceFile.trim() : '';
    const details = [title, summary].filter(Boolean).join(' - ');
    const label = [kind, layer && `layer=${layer}`, sourceFile && `source=${sourceFile}`]
      .filter(Boolean)
      .join(' ');

    if (details) {
      return `- ${label}: ${truncateInline(details, 280)}`;
    }
  }

  if (typeof content === 'string' && content.trim()) {
    return `- ${kind}: ${truncateInline(content.trim(), 280)}`;
  }

  const fallback = JSON.stringify(content);
  if (!fallback || fallback === 'undefined') {
    return undefined;
  }

  return `- ${kind}: ${truncateInline(fallback, 280)}`;
}

function truncateInline(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 3)}...`;
}
