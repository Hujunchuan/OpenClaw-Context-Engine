import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { OpenClawHypergraphAdapter } from './openclaw-adapter.js';
import { SQLiteStore } from './sqlite-store.js';

export interface RuntimeAdapterConfig {
  dbPath?: string;
  disablePersistence?: boolean;
}

type RuntimeConfigLike =
  | RuntimeAdapterConfig
  | {
      config?: RuntimeAdapterConfig;
      pluginConfig?: RuntimeAdapterConfig;
      contextEngineConfig?: RuntimeAdapterConfig;
    };

declare global {
  // Global caches keep the adapter/store stable even if the runtime creates a
  // fresh plugin object for every turn.
  var __openClawHypergraphAdapterCache: Map<string, OpenClawHypergraphAdapter> | undefined;
  var __openClawHypergraphStoreCache: Map<string, SQLiteStore> | undefined;
}

export function getOrCreateRuntimeAdapter(input?: RuntimeConfigLike): OpenClawHypergraphAdapter {
  const config = normalizeRuntimeAdapterConfig(input);
  const cacheKey = config.disablePersistence ? 'memory' : `sqlite:${config.dbPath}`;
  const cached = getAdapterCache().get(cacheKey);
  if (cached) {
    return cached;
  }

  const adapter = config.disablePersistence
    ? new OpenClawHypergraphAdapter()
    : new OpenClawHypergraphAdapter({ store: getOrCreateStore(config.dbPath!) });

  getAdapterCache().set(cacheKey, adapter);
  return adapter;
}

export function normalizeRuntimeAdapterConfig(input?: RuntimeConfigLike): RuntimeAdapterConfig {
  const runtimeConfig = extractRuntimeConfig(input);
  const disablePersistence =
    runtimeConfig.disablePersistence ?? readBooleanEnv('OPENCLAW_CONTEXT_ENGINE_DISABLE_PERSISTENCE') ?? false;

  if (disablePersistence) {
    return { disablePersistence: true };
  }

  return {
    disablePersistence: false,
    dbPath: resolveDbPath(runtimeConfig.dbPath),
  };
}

function extractRuntimeConfig(input?: RuntimeConfigLike): RuntimeAdapterConfig {
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

  return input as RuntimeAdapterConfig;
}

function resolveDbPath(explicitPath?: string): string {
  const envPath = process.env.OPENCLAW_CONTEXT_ENGINE_DB_PATH;
  const envDataDir = process.env.OPENCLAW_CONTEXT_ENGINE_DATA_DIR ?? process.env.OPENCLAW_PLUGIN_DATA_DIR ?? process.env.OPENCLAW_DATA_DIR;
  const candidate = explicitPath ?? envPath;

  if (candidate) {
    return resolve(candidate);
  }

  if (envDataDir) {
    return resolve(join(envDataDir, 'hypergraph-context-engine.sqlite'));
  }

  return resolve(join(tmpdir(), 'openclaw-context-engine', 'hypergraph-context-engine.sqlite'));
}

function getOrCreateStore(filename: string): SQLiteStore {
  const cache = getStoreCache();
  const cached = cache.get(filename);
  if (cached) {
    return cached;
  }

  const store = new SQLiteStore(filename);
  cache.set(filename, store);
  return store;
}

function getAdapterCache(): Map<string, OpenClawHypergraphAdapter> {
  globalThis.__openClawHypergraphAdapterCache ??= new Map<string, OpenClawHypergraphAdapter>();
  return globalThis.__openClawHypergraphAdapterCache;
}

function getStoreCache(): Map<string, SQLiteStore> {
  globalThis.__openClawHypergraphStoreCache ??= new Map<string, SQLiteStore>();
  return globalThis.__openClawHypergraphStoreCache;
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
