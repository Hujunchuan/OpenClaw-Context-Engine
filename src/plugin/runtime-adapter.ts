import { OpenClawHypergraphAdapter } from './openclaw-adapter.js';
import { SQLiteStore } from '../core/sqlite-store.js';
import { normalizeContextEngineConfig, type ContextEngineConfigInput, type ResolvedContextEngineConfig } from './config.js';

declare global {
  // Global caches keep the adapter/store stable even if the runtime creates a
  // fresh plugin object for every turn.
  var __openClawHypergraphPluginAdapterCache: Map<string, OpenClawHypergraphAdapter> | undefined;
  var __openClawHypergraphPluginStoreCache: Map<string, SQLiteStore> | undefined;
}

export function getOrCreateRuntimeAdapter(input?: RuntimeConfigLike): OpenClawHypergraphAdapter {
  const config = normalizeRuntimeAdapterConfig(input);
  const cacheKey = config.disablePersistence
    ? `memory:${config.memoryWorkspaceRoot}`
    : `sqlite:${config.dbPath}|memory:${config.memoryWorkspaceRoot}`;
  const cached = getAdapterCache().get(cacheKey);
  if (cached) {
    return cached;
  }

  const adapter = config.disablePersistence
    ? new OpenClawHypergraphAdapter({
        memoryWorkspaceRoot: config.memoryWorkspaceRoot,
        enableLayeredRead: config.enableLayeredRead,
        enableLayeredWrite: config.enableLayeredWrite,
        flushOnAfterTurn: config.flushOnAfterTurn,
        flushOnCompact: config.flushOnCompact,
        promoteOnMaintenance: config.promoteOnMaintenance,
      })
    : new OpenClawHypergraphAdapter({
        store: getOrCreateStore(config.dbPath!),
        memoryWorkspaceRoot: config.memoryWorkspaceRoot,
        enableLayeredRead: config.enableLayeredRead,
        enableLayeredWrite: config.enableLayeredWrite,
        flushOnAfterTurn: config.flushOnAfterTurn,
        flushOnCompact: config.flushOnCompact,
        promoteOnMaintenance: config.promoteOnMaintenance,
      });

  getAdapterCache().set(cacheKey, adapter);
  return adapter;
}

export function normalizeRuntimeAdapterConfig(input?: RuntimeConfigLike): RuntimeAdapterConfig {
  return normalizeContextEngineConfig(input);
}

export type RuntimeAdapterConfig = ResolvedContextEngineConfig;
type RuntimeConfigLike = ContextEngineConfigInput;

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
  if (!globalThis.__openClawHypergraphPluginAdapterCache) {
    globalThis.__openClawHypergraphPluginAdapterCache = new Map<string, OpenClawHypergraphAdapter>();
  }

  return globalThis.__openClawHypergraphPluginAdapterCache;
}

function getStoreCache(): Map<string, SQLiteStore> {
  if (!globalThis.__openClawHypergraphPluginStoreCache) {
    globalThis.__openClawHypergraphPluginStoreCache = new Map<string, SQLiteStore>();
  }

  return globalThis.__openClawHypergraphPluginStoreCache;
}
