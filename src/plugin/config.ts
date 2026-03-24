import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export interface ContextEnginePluginConfig {
  dbPath?: string;
  disablePersistence?: boolean;
  memoryWorkspaceRoot?: string;
  enableLayeredRead?: boolean;
  enableLayeredWrite?: boolean;
  enableQueryGate?: boolean;
  disableLongTermMemoryForConversationQueries?: boolean;
  flushOnAfterTurn?: boolean;
  flushOnCompact?: boolean;
  promoteOnMaintenance?: boolean;
  runtimeIdentityDebug?: boolean;
}

export type ContextEngineConfigInput =
  | ContextEnginePluginConfig
  | {
      config?: ContextEnginePluginConfig;
      pluginConfig?: ContextEnginePluginConfig;
      contextEngineConfig?: ContextEnginePluginConfig;
    };

export interface ResolvedContextEngineConfig {
  dbPath?: string;
  disablePersistence: boolean;
  memoryWorkspaceRoot: string;
  enableLayeredRead: boolean;
  enableLayeredWrite: boolean;
  enableQueryGate: boolean;
  disableLongTermMemoryForConversationQueries: boolean;
  flushOnAfterTurn: boolean;
  flushOnCompact: boolean;
  promoteOnMaintenance: boolean;
  runtimeIdentityDebug: boolean;
}

export const CONTEXT_ENGINE_PLUGIN_INFO = {
  id: 'hypergraph-context-engine',
  name: 'Hypergraph Context Engine',
  version: '0.1.0',
  kind: 'context-engine',
  description: 'Task-state-guided context engine prototype for OpenClaw.',
  ownsCompaction: false,
} as const;

export const CONTEXT_ENGINE_CONFIG_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    dbPath: {
      type: 'string',
      description: 'Optional absolute or relative SQLite path for persisted semantic state.',
    },
    disablePersistence: {
      type: 'boolean',
      description: 'Disable SQLite persistence and keep state in memory only.',
    },
    memoryWorkspaceRoot: {
      type: 'string',
      description: 'Root directory where NOW.md, MEMORY.md, and memory/hot|warm|cold files are stored.',
    },
    enableLayeredRead: {
      type: 'boolean',
      description: 'Hydrate layered Markdown memory into memory_chunk nodes before assemble.',
    },
    enableLayeredWrite: {
      type: 'boolean',
      description: 'Write NOW.md and layered Markdown memory files during flushMemory.',
    },
    enableQueryGate: {
      type: 'boolean',
      description: 'Use conversation-aware query gating so short recall or low-information turns do not overuse long-term memory.',
    },
    disableLongTermMemoryForConversationQueries: {
      type: 'boolean',
      description: 'Keep conversation-style recall focused on transcript, task state, and session-hot memory instead of warm/cold global memory.',
    },
    flushOnAfterTurn: {
      type: 'boolean',
      description: 'Automatically flush layered memory after each turn.',
    },
    flushOnCompact: {
      type: 'boolean',
      description: 'Flush layered memory before compaction runs.',
    },
    promoteOnMaintenance: {
      type: 'boolean',
      description: 'Re-hydrate and apply lifecycle maintenance during afterTurn.',
    },
    runtimeIdentityDebug: {
      type: 'boolean',
      description: 'Append debug-only runtime identity diagnostics so real OpenClaw namespace alignment can be inspected during integration testing.',
    },
  },
} as const;

export function normalizeContextEngineConfig(input?: ContextEngineConfigInput): ResolvedContextEngineConfig {
  const runtimeConfig = extractContextEngineConfig(input);
  const disablePersistence =
    runtimeConfig.disablePersistence ?? readBooleanEnv('OPENCLAW_CONTEXT_ENGINE_DISABLE_PERSISTENCE') ?? false;

  return {
    disablePersistence,
    dbPath: disablePersistence ? undefined : resolveDbPath(runtimeConfig.dbPath),
    memoryWorkspaceRoot: resolveMemoryWorkspaceRoot(runtimeConfig.memoryWorkspaceRoot),
    enableLayeredRead: runtimeConfig.enableLayeredRead ?? true,
    enableLayeredWrite: runtimeConfig.enableLayeredWrite ?? true,
    enableQueryGate: runtimeConfig.enableQueryGate ?? readBooleanEnv('OPENCLAW_CONTEXT_ENGINE_ENABLE_QUERY_GATE') ?? true,
    disableLongTermMemoryForConversationQueries:
      runtimeConfig.disableLongTermMemoryForConversationQueries
      ?? readBooleanEnv('OPENCLAW_CONTEXT_ENGINE_DISABLE_LONG_TERM_MEMORY_FOR_CONVERSATION_QUERIES')
      ?? true,
    flushOnAfterTurn: runtimeConfig.flushOnAfterTurn ?? true,
    flushOnCompact: runtimeConfig.flushOnCompact ?? true,
    promoteOnMaintenance: runtimeConfig.promoteOnMaintenance ?? true,
    runtimeIdentityDebug:
      runtimeConfig.runtimeIdentityDebug
      ?? readBooleanEnv('OPENCLAW_CONTEXT_ENGINE_RUNTIME_IDENTITY_DEBUG')
      ?? false,
  };
}

export function extractContextEngineConfig(input?: ContextEngineConfigInput): ContextEnginePluginConfig {
  if (!input || typeof input !== 'object') {
    return {};
  }

  if ('config' in input && input.config && typeof input.config === 'object') {
    return input.config;
  }

  if ('pluginConfig' in input && input.pluginConfig && typeof input.pluginConfig === 'object') {
    return input.pluginConfig;
  }

  if ('contextEngineConfig' in input && input.contextEngineConfig && typeof input.contextEngineConfig === 'object') {
    return input.contextEngineConfig;
  }

  return input as ContextEnginePluginConfig;
}

function resolveDbPath(explicitPath?: string): string {
  const envPath = process.env.OPENCLAW_CONTEXT_ENGINE_DB_PATH;
  const envDataDir =
    process.env.OPENCLAW_CONTEXT_ENGINE_DATA_DIR ?? process.env.OPENCLAW_PLUGIN_DATA_DIR ?? process.env.OPENCLAW_DATA_DIR;
  const candidate = explicitPath ?? envPath;

  if (candidate) {
    return resolve(candidate);
  }

  if (envDataDir) {
    return resolve(join(envDataDir, 'hypergraph-context-engine.sqlite'));
  }

  return resolve(join(tmpdir(), 'openclaw-context-engine', 'hypergraph-context-engine.sqlite'));
}

function resolveMemoryWorkspaceRoot(explicitPath?: string): string {
  const envPath = process.env.OPENCLAW_CONTEXT_ENGINE_MEMORY_ROOT ?? process.env.OPENCLAW_MEMORY_ROOT;
  const envDataDir =
    process.env.OPENCLAW_CONTEXT_ENGINE_DATA_DIR ?? process.env.OPENCLAW_PLUGIN_DATA_DIR ?? process.env.OPENCLAW_DATA_DIR;
  const candidate = explicitPath ?? envPath;

  if (candidate) {
    return resolve(candidate);
  }

  if (envDataDir) {
    return resolve(join(envDataDir, 'memory-workspace'));
  }

  return resolve(join(tmpdir(), 'openclaw-context-engine', 'memory-workspace'));
}

function readBooleanEnv(name: string): boolean | undefined {
  const raw = process.env[name];
  if (!raw) {
    return undefined;
  }

  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return undefined;
}
