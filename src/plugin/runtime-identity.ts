import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, normalize, resolve } from 'node:path';

import type { MemoryNamespaceContext } from '../../schemas/types.js';
import { normalizeRuntimeContentToText, shouldSyncRuntimeMessage } from './runtime-message-utils.js';

declare global {
  var __openClawRuntimeIdentityAliasByFingerprint: Map<string, string> | undefined;
  var __openClawRuntimeIdentityAliasByRawSessionId: Map<string, string> | undefined;
  var __openClawRuntimeIdentityAliasBySessionFile: Map<string, string> | undefined;
}

export interface CanonicalRuntimeIdentity extends MemoryNamespaceContext {
  sessionKey?: string;
  sessionFile?: string;
  rawSessionId?: string;
}

export interface RuntimeIdentityResolution {
  namespace: CanonicalRuntimeIdentity;
  sources: {
    sessionId:
      | 'sessionId'
      | 'sessionKey'
      | 'alias.rawSessionId'
      | 'alias.sessionFile'
      | 'alias.messageFingerprint'
      | 'missing';
    agentId: 'agentId' | 'runtimeContext.agentId' | 'runtimeContext.agent.id' | 'missing';
    workspaceId:
      | 'workspaceId'
      | 'workspaceDir'
      | 'runtimeContext.workspaceId'
      | 'runtimeContext.workspaceDir'
      | 'runtimeContext.projectDir'
      | 'sessionFile'
      | 'missing';
  };
}

export function resolveCanonicalRuntimeIdentity(params: Record<string, unknown>): RuntimeIdentityResolution {
  const runtimeContext = asRecord(params.runtimeContext);
  const runtimeAgent = asRecord(runtimeContext?.agent);
  const rawSessionId = readString(params.sessionId);
  const sessionKey = readString(params.sessionKey);
  const sessionFile = readString(params.sessionFile);
  const directAgentId = readString(params.agentId);
  const runtimeAgentId = readString(runtimeContext?.agentId);
  const nestedAgentId = readString(runtimeAgent?.id);
  const directWorkspaceId = readString(params.workspaceId);
  const directWorkspaceDir = readString(params.workspaceDir);
  const runtimeWorkspaceId = readString(runtimeContext?.workspaceId);
  const runtimeWorkspaceDir = readString(runtimeContext?.workspaceDir);
  const runtimeProjectDir = readString(runtimeContext?.projectDir);
  const sessionFileWorkspace = readWorkspaceFromSessionFile(sessionFile);
  const alias = resolveRuntimeIdentityAlias({
    rawSessionId,
    sessionFile,
    messages: asMessageArray(params.messages),
  });

  const sessionId = alias.sessionId ?? rawSessionId ?? sessionKey;
  const agentId = directAgentId ?? runtimeAgentId ?? nestedAgentId;
  const workspaceCandidate = directWorkspaceId
    ?? directWorkspaceDir
    ?? runtimeWorkspaceId
    ?? runtimeWorkspaceDir
    ?? runtimeProjectDir
    ?? sessionFileWorkspace;

  return {
    namespace: {
      sessionId: sessionId ?? '',
      agentId,
      workspaceId: normalizeWorkspaceId(workspaceCandidate),
      sessionKey,
      sessionFile,
      rawSessionId,
    },
    sources: {
      sessionId: alias.source ?? (rawSessionId ? 'sessionId' : sessionKey ? 'sessionKey' : 'missing'),
      agentId: directAgentId
        ? 'agentId'
        : runtimeAgentId
          ? 'runtimeContext.agentId'
          : nestedAgentId
            ? 'runtimeContext.agent.id'
            : 'missing',
      workspaceId: directWorkspaceId
        ? 'workspaceId'
        : directWorkspaceDir
          ? 'workspaceDir'
          : runtimeWorkspaceId
            ? 'runtimeContext.workspaceId'
            : runtimeWorkspaceDir
              ? 'runtimeContext.workspaceDir'
              : runtimeProjectDir
                ? 'runtimeContext.projectDir'
                : sessionFileWorkspace
                  ? 'sessionFile'
                  : 'missing',
    },
  };
}

export function rememberRuntimeIdentityObservation(params: {
  namespace: CanonicalRuntimeIdentity;
  messages?: Array<Record<string, unknown>>;
}): void {
  const sessionId = params.namespace.sessionId;
  if (!sessionId) {
    return;
  }

  const fingerprint = createMessageFingerprint(params.messages);
  if (fingerprint) {
    getFingerprintAliasCache().set(fingerprint, sessionId);
  }

  if (params.namespace.rawSessionId && params.namespace.rawSessionId !== sessionId) {
    getRawSessionAliasCache().set(params.namespace.rawSessionId, sessionId);
  }

  if (params.namespace.sessionFile && params.namespace.rawSessionId !== sessionId) {
    getSessionFileAliasCache().set(params.namespace.sessionFile, sessionId);
  }
}

export function writeRuntimeIdentityDiagnostic(params: {
  enabled: boolean;
  memoryWorkspaceRoot?: string;
  lifecycle: string;
  resolution: RuntimeIdentityResolution;
}): void {
  if (!params.enabled || !params.memoryWorkspaceRoot) {
    return;
  }

  const logPath = resolve(params.memoryWorkspaceRoot, 'runtime-identity-debug.log');
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(
    logPath,
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      lifecycle: params.lifecycle,
      namespace: params.resolution.namespace,
      sources: params.resolution.sources,
    })}\n`,
    'utf8',
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function asMessageArray(value: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readWorkspaceFromSessionFile(sessionFile: string | undefined): string | undefined {
  if (!sessionFile) {
    return undefined;
  }

  const parent = dirname(sessionFile);
  if (!parent || parent === '.' || parent === '') {
    return undefined;
  }

  return parent;
}

function normalizeWorkspaceId(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = isAbsolute(value)
    ? normalize(value)
    : value.replace(/[\\/]+$/g, '').trim();
  const stable = normalized.replace(/\\/g, '/');
  return stable || undefined;
}

function resolveRuntimeIdentityAlias(params: {
  rawSessionId?: string;
  sessionFile?: string;
  messages?: Array<Record<string, unknown>>;
}): {
  sessionId?: string;
  source?: RuntimeIdentityResolution['sources']['sessionId'];
} {
  const fingerprint = createMessageFingerprint(params.messages);
  if (fingerprint) {
    const fingerprintMatch = getFingerprintAliasCache().get(fingerprint);
    if (fingerprintMatch && fingerprintMatch !== params.rawSessionId) {
      return {
        sessionId: fingerprintMatch,
        source: 'alias.messageFingerprint',
      };
    }
  }

  if (params.rawSessionId) {
    const rawMatch = getRawSessionAliasCache().get(params.rawSessionId);
    if (rawMatch && rawMatch !== params.rawSessionId) {
      return {
        sessionId: rawMatch,
        source: 'alias.rawSessionId',
      };
    }
  }

  if (params.sessionFile) {
    const fileMatch = getSessionFileAliasCache().get(params.sessionFile);
    if (fileMatch && fileMatch !== params.rawSessionId) {
      return {
        sessionId: fileMatch,
        source: 'alias.sessionFile',
      };
    }
  }

  return {};
}

function createMessageFingerprint(messages: Array<Record<string, unknown>> | undefined): string | undefined {
  if (!messages || messages.length === 0) {
    return undefined;
  }

  const normalizedUserMessages = messages
    .filter(shouldSyncRuntimeMessage)
    .filter((message) => readString(message.role)?.toLowerCase() === 'user')
    .map((message) => normalizeRuntimeContentToText(message.content))
    .map((text) => text.replace(/\s+/g, ' ').trim().toLowerCase())
    .filter(Boolean)
    .slice(-3);

  if (normalizedUserMessages.length === 0) {
    return undefined;
  }

  return normalizedUserMessages.join(' || ');
}

function getFingerprintAliasCache(): Map<string, string> {
  if (!globalThis.__openClawRuntimeIdentityAliasByFingerprint) {
    globalThis.__openClawRuntimeIdentityAliasByFingerprint = new Map<string, string>();
  }

  return globalThis.__openClawRuntimeIdentityAliasByFingerprint;
}

function getRawSessionAliasCache(): Map<string, string> {
  if (!globalThis.__openClawRuntimeIdentityAliasByRawSessionId) {
    globalThis.__openClawRuntimeIdentityAliasByRawSessionId = new Map<string, string>();
  }

  return globalThis.__openClawRuntimeIdentityAliasByRawSessionId;
}

function getSessionFileAliasCache(): Map<string, string> {
  if (!globalThis.__openClawRuntimeIdentityAliasBySessionFile) {
    globalThis.__openClawRuntimeIdentityAliasBySessionFile = new Map<string, string>();
  }

  return globalThis.__openClawRuntimeIdentityAliasBySessionFile;
}
