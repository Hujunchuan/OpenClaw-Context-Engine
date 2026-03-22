import type { MemoryChunkPayload } from '../../schemas/types.js';

export interface LifecycleOptions {
  now?: string;
}

const HOT_TO_WARM_HIT_THRESHOLD = 3;
const HOT_TO_WARM_WINDOW_DAYS = 7;
const WARM_TO_COLD_SESSION_THRESHOLD = 3;
const WARM_TO_COLD_MIN_AGE_DAYS = 14;
const HOT_ARCHIVE_AFTER_DAYS = 14;

export function mergeMemoryEntryState(
  existing: MemoryChunkPayload | undefined,
  incoming: MemoryChunkPayload,
  options: LifecycleOptions = {},
): MemoryChunkPayload {
  const now = options.now ?? new Date().toISOString();
  const mergedHitCount = (existing?.hitCount ?? 0) + 1;
  const mergedSessionCount = existing?.lastSessionId === incoming.lastSessionId
    ? existing?.sessionCount ?? incoming.sessionCount ?? 1
    : Math.max(existing?.sessionCount ?? 0, incoming.sessionCount ?? 0, 0) + 1;

  const merged: MemoryChunkPayload = {
    ...existing,
    ...incoming,
    summary: mergeSummary(existing?.summary, incoming.summary, incoming.layer),
    text: mergeText(existing?.text, incoming.text, incoming.layer),
    routeReason: incoming.routeReason ?? existing?.routeReason,
    recurrence: Math.max(incoming.recurrence, existing?.recurrence ?? 0, mergedHitCount),
    connectivity: Math.max(incoming.connectivity, existing?.connectivity ?? 0),
    firstSeenAt: existing?.firstSeenAt ?? incoming.firstSeenAt ?? now,
    updatedAt: now,
    hitCount: mergedHitCount,
    sessionCount: mergedSessionCount,
    lastSessionId: incoming.lastSessionId ?? existing?.lastSessionId,
    status: incoming.status ?? existing?.status ?? 'active',
  };

  return applyLifecyclePolicy(merged, options);
}

export function applyLifecyclePolicy(entry: MemoryChunkPayload, options: LifecycleOptions = {}): MemoryChunkPayload {
  const now = options.now ?? new Date().toISOString();
  const ageDays = daysBetween(entry.firstSeenAt ?? entry.updatedAt, now);
  const staleDays = daysBetween(entry.updatedAt, now);

  if (entry.status === 'invalidated') {
    return {
      ...entry,
      layer: entry.layer === 'daily_log' ? entry.layer : 'archive',
      status: 'invalidated',
    };
  }

  if (entry.layer === 'hot' && staleDays >= HOT_ARCHIVE_AFTER_DAYS && entry.hitCount === 0) {
    return {
      ...entry,
      layer: 'archive',
      status: 'archived',
    };
  }

  if (entry.layer === 'hot' && shouldPromoteHotToWarm(entry, now)) {
    return {
      ...entry,
      layer: 'warm',
    };
  }

  if (
    entry.layer === 'warm'
    && (entry.sessionCount ?? 0) >= WARM_TO_COLD_SESSION_THRESHOLD
    && ageDays >= WARM_TO_COLD_MIN_AGE_DAYS
  ) {
    return {
      ...entry,
      layer: 'cold',
    };
  }

  return entry;
}

function shouldPromoteHotToWarm(entry: MemoryChunkPayload, now: string): boolean {
  if ((entry.hitCount ?? 0) >= HOT_TO_WARM_HIT_THRESHOLD) {
    return true;
  }

  const recentAgeDays = daysBetween(entry.firstSeenAt ?? entry.updatedAt, now);
  return recentAgeDays <= HOT_TO_WARM_WINDOW_DAYS && (entry.recurrence ?? 0) >= HOT_TO_WARM_HIT_THRESHOLD;
}

function mergeSummary(existing: string | undefined, incoming: string, layer: MemoryChunkPayload['layer']): string {
  if (!existing || layer === 'hot' || layer === 'cold') {
    return incoming;
  }

  if (existing.includes(incoming)) {
    return existing;
  }

  return `${existing}\n- ${incoming}`;
}

function mergeText(existing: string | undefined, incoming: string | undefined, layer: MemoryChunkPayload['layer']): string | undefined {
  if (!incoming) {
    return existing;
  }

  if (!existing || layer === 'hot' || layer === 'cold') {
    return incoming;
  }

  if (existing.includes(incoming)) {
    return existing;
  }

  return `${existing}\n${incoming}`;
}

function daysBetween(from: string | undefined, to: string): number {
  if (!from) {
    return 0;
  }

  const fromTime = Date.parse(from);
  const toTime = Date.parse(to);
  if (Number.isNaN(fromTime) || Number.isNaN(toTime)) {
    return 0;
  }

  return Math.max(0, Math.floor((toTime - fromTime) / (1000 * 60 * 60 * 24)));
}
