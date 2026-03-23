import type { OpenClawAdapterAssembleResult } from './openclaw-adapter.js';
import { CONTEXT_ENGINE_PLUGIN_INFO, type ContextEnginePluginConfig } from './config.js';
import { getOrCreateRuntimeAdapter } from './runtime-adapter.js';

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
  agentId?: string;
  sessionKey?: string;
  workspaceDir?: string;
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
  const adapter = getOrCreateRuntimeAdapter(api.pluginConfig as ContextEnginePluginConfig | undefined);
  const logger = api.logger;

  logger?.info?.(
    `[${CONTEXT_ENGINE_PLUGIN_INFO.id}] OpenClaw hook bridge enabled; using before_agent_start/agent_end/before_compaction fallback.`,
  );

  api.on(
    'before_agent_start',
    async (event: BeforeAgentStartEvent, ctx: BeforeAgentStartContext) => {
      const sessionId = resolveHookSessionId(ctx);
      if (!sessionId) {
        logger?.warn?.(`[${CONTEXT_ENGINE_PLUGIN_INFO.id}] skipped before_agent_start: missing session identity.`);
        return;
      }

      const messages = normalizeHookMessages(event.messages);
      await syncHookMessages(adapter, sessionId, messages);

      const assembled = await adapter.assemble({
        sessionId,
        currentTurnText: extractLatestUserText(messages) ?? event.prompt,
        tokenBudget: DEFAULT_TOKEN_BUDGET,
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
      const sessionId = resolveHookSessionId(ctx);
      if (!sessionId) {
        return;
      }

      const messages = normalizeHookMessages(event.messages);
      await syncHookMessages(adapter, sessionId, messages);
      await adapter.afterTurn({ sessionId });
      logger?.debug?.(
        `[${CONTEXT_ENGINE_PLUGIN_INFO.id}] completed agent_end maintenance for ${sessionId} (success=${event.success}).`,
      );
    },
    { priority: 50 },
  );

  api.on(
    'before_compaction',
    async (_event: BeforeCompactionEvent, ctx: AgentHookContext) => {
      const sessionId = resolveHookSessionId(ctx);
      if (!sessionId) {
        return;
      }

      await adapter.flushMemory({
        sessionId,
        reason: 'compaction',
      });
      logger?.debug?.(`[${CONTEXT_ENGINE_PLUGIN_INFO.id}] flushed layered memory before compaction for ${sessionId}.`);
    },
    { priority: 50 },
  );
}

function resolveHookSessionId(ctx: AgentHookContext): string | undefined {
  const candidate = ctx.sessionKey ?? ctx.agentId;
  return candidate ? String(candidate) : undefined;
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
    entries: messages,
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
  const kind = typeof message.kind === 'string' ? message.kind : 'context';
  const content = message.content;

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

function extractLatestUserText(messages: HookMessage[]): string | undefined {
  const reversed = [...messages].reverse();
  for (const message of reversed) {
    if ((message.role === 'user' || message.type === 'user') && typeof message.content === 'string') {
      return message.content;
    }
  }

  return undefined;
}
