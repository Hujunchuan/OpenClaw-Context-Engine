import type {
  BaseNode,
  FlushReason,
  MemoryChunkPayload,
  MemoryLayer,
  MemoryNamespaceContext,
  MemoryScope,
  TaskState,
} from '../../schemas/types.js';
import {
  extractExplicitNextStep,
  extractExplicitTaskDefinition,
  looksLikeLowSignalStateNoise,
  looksLikeRecallIntent,
  looksLikeSyntheticContextBridgeText,
} from '../core/dialogue-cues.js';

export interface LayeredMemoryCandidate {
  title: string;
  summary: string;
  details?: string[];
  category?: string;
  scope: MemoryScope;
  persistence: MemoryChunkPayload['persistence'];
  recurrence: number;
  connectivity: number;
  activationEnergy: MemoryChunkPayload['activationEnergy'];
}

export interface RoutedLayeredMemoryEntry extends MemoryChunkPayload {
  relativePath: string;
  details: string[];
}

export interface NowDocumentState {
  currentTask: string | null;
  currentPlan: string[];
  blockers: string[];
  nextSteps: string[];
  updatedAt: string;
  lastSessionId?: string;
  lastAgentId?: string;
  lastWorkspaceId?: string;
}

export interface LayeredMemoryFlushPlan {
  nowState: NowDocumentState;
  entries: RoutedLayeredMemoryEntry[];
  dailyAudit: string[];
}

export interface RouteLayeredMemoryParams extends MemoryNamespaceContext {
  taskState: TaskState;
  nodes: BaseNode[];
  existingEntries?: MemoryChunkPayload[];
  reason: FlushReason;
  now?: string;
}

export const HYPERGRAPH_MEMORY_ROOT = '.hypergraph-memory';

type NamespacePathContext = {
  sessionId?: string;
  agentId?: string;
  workspaceId?: string;
  lastSessionId?: string;
  lastAgentId?: string;
  lastWorkspaceId?: string;
};

const REUSABLE_PATTERN_CUES = [
  /\b(pattern|workflow|checklist|playbook|reusable|repeat(?:ed|ing)?|template|debug|troubleshoot|fallback|degrade gracefully)\b/i,
  /模式|流程|经验|套路|复用|排障|降级|回退/u,
];
const LONG_TERM_CUES = [
  /\b(prefer|preference|profile|background|principle|source of truth|always|never)\b/i,
  /偏好|背景|原则|事实源|长期/u,
];

export function routeLayeredMemory(params: RouteLayeredMemoryParams): LayeredMemoryFlushPlan {
  const now = params.now ?? new Date().toISOString();
  const existingByKey = new Map(
    (params.existingEntries ?? [])
      .filter((entry) => typeof entry.dedupeKey === 'string')
      .map((entry) => [entry.dedupeKey, entry]),
  );
  const candidates = collectCandidates(params.taskState, params.nodes, existingByKey, params);
  const entries = candidates.map((candidate) => {
    const routed = routeMemoryCandidate(candidate);
    const dedupeKey = routed.layer === 'hot'
      ? qualifyNamespacedDedupeKey(`hot-${routed.category ?? 'current-task'}`, params)
      : routed.dedupeKey;
    const existing = existingByKey.get(dedupeKey);
    const recurrence = Math.max(routed.recurrence, (existing?.recurrence ?? 0) + 1);
    const connectivity = Math.max(routed.connectivity, existing?.connectivity ?? 0);
    const hitCount = (existing?.hitCount ?? 0) + 1;
    const sessionCount = existing?.lastSessionId === params.sessionId ? existing?.sessionCount ?? 1 : (existing?.sessionCount ?? 0) + 1;

    return {
      ...routed,
      dedupeKey,
      updatedAt: now,
      firstSeenAt: existing?.firstSeenAt ?? now,
      hitCount,
      sessionCount,
      recurrence,
      connectivity,
      lastSessionId: params.sessionId,
      lastAgentId: params.agentId,
      lastWorkspaceId: params.workspaceId,
      relativePath: resolveMemoryRelativePath({
        layer: routed.layer,
        category: routed.category,
        dedupeKey,
        lastSessionId: params.sessionId,
        lastAgentId: params.agentId,
        lastWorkspaceId: params.workspaceId,
      }),
    };
  });

  return {
    nowState: buildNowState(params.taskState, params.nodes, existingByKey, now, {
      sessionId: params.sessionId,
      agentId: params.agentId,
      workspaceId: params.workspaceId,
    }),
    entries,
    dailyAudit: buildDailyAudit(params, entries),
  };
}

export function routeMemoryCandidate(candidate: LayeredMemoryCandidate): RoutedLayeredMemoryEntry {
  const layer = classifyMemoryLayer(candidate);
  const category = candidate.category ?? inferCategory(candidate, layer);
  const dedupeKey = createDedupeKey(category, candidate.title, candidate.summary);
  const detailLevels = buildDetailLevels(candidate);

  const entry: RoutedLayeredMemoryEntry = {
    layer,
    scope: candidate.scope,
    sourceFile: '',
    title: candidate.title,
    summary: candidate.summary,
    abstract: detailLevels.abstract,
    overview: detailLevels.overview,
    detail: detailLevels.detail,
    text: detailLevels.detail,
    category,
    routeReason: describeRouteReason(candidate, layer),
    dedupeKey,
    persistence: candidate.persistence,
    recurrence: candidate.recurrence,
    connectivity: candidate.connectivity,
    activationEnergy: candidate.activationEnergy,
    status: 'active',
    updatedAt: new Date().toISOString(),
    details: candidate.details ?? [],
    relativePath: '',
  };

  entry.relativePath = resolveMemoryRelativePath({
    layer: entry.layer,
    category: entry.category,
    dedupeKey: entry.dedupeKey,
  });

  return entry;
}

export function classifyMemoryLayer(candidate: LayeredMemoryCandidate): MemoryLayer {
  if (
    candidate.scope === 'task'
    || candidate.persistence === 'turn'
    || candidate.persistence === 'task'
    || candidate.activationEnergy === 'low'
  ) {
    return 'hot';
  }

  if (
    candidate.scope === 'workflow'
    || candidate.recurrence >= 3
    || matchesAny(REUSABLE_PATTERN_CUES, `${candidate.title} ${candidate.summary}`)
  ) {
    return 'warm';
  }

  if (
    candidate.scope === 'user'
    || candidate.scope === 'system'
    || candidate.persistence === 'long_term'
    || matchesAny(LONG_TERM_CUES, `${candidate.title} ${candidate.summary}`)
  ) {
    return 'cold';
  }

  return 'warm';
}

export function resolveMemoryRelativePath(
  entry: Pick<
    RoutedLayeredMemoryEntry,
    'layer' | 'category' | 'dedupeKey' | 'lastSessionId' | 'lastAgentId' | 'lastWorkspaceId'
  >,
): string {
  const namespaceDir = resolveNamespaceDirectory(entry);

  if (entry.layer === 'daily_log') {
    return resolveDailyLogRelativePath(new Date().toISOString().slice(0, 10));
  }

  if (entry.layer === 'archive') {
    const namespace = resolveNamespaceSegments(entry);
    const archiveDir = `${HYPERGRAPH_MEMORY_ROOT}/archive/${namespace.kind}${namespace.slug ? `/${namespace.slug}` : ''}`;
    return `${archiveDir}/archive--${slugify(entry.category ?? 'memory')}--${slugify(entry.dedupeKey)}.md`;
  }

  if (entry.layer === 'memory_core') {
    return resolveMemoryCoreRelativePath();
  }

  return `${namespaceDir}/${entry.layer}--${slugify(entry.category ?? 'memory')}--${slugify(entry.dedupeKey)}.md`;
}

export function resolveNowRelativePath(namespace: NamespacePathContext): string {
  const resolved = resolveNamespaceSegments(namespace);
  const filename = resolved.kind === 'session'
    ? 'SESSION_NOW.md'
    : resolved.kind === 'agent'
      ? 'AGENT_NOW.md'
      : resolved.kind === 'workspace'
        ? 'WORKSPACE_NOW.md'
        : 'GLOBAL_NOW.md';

  return `${HYPERGRAPH_MEMORY_ROOT}/${resolved.kind}${resolved.slug ? `/${resolved.slug}` : ''}/${filename}`;
}

export function resolveMemoryCoreRelativePath(): string {
  return `${HYPERGRAPH_MEMORY_ROOT}/global/GLOBAL_MEMORY.md`;
}

export function resolveDailyLogRelativePath(date: string): string {
  return `${HYPERGRAPH_MEMORY_ROOT}/archive/daily/${date}.md`;
}

export function qualifyNamespacedDedupeKey(base: string, namespace: NamespacePathContext): string {
  const segments = [
    slugify(base),
    readNamespaceWorkspaceId(namespace) ? `workspace-${slugify(readNamespaceWorkspaceId(namespace)!)}` : undefined,
    readNamespaceAgentId(namespace) ? `agent-${slugify(readNamespaceAgentId(namespace)!)}` : undefined,
    readNamespaceSessionId(namespace) ? `session-${slugify(readNamespaceSessionId(namespace)!)}` : undefined,
  ].filter((value): value is string => Boolean(value));

  return segments.join('--');
}

function collectCandidates(
  taskState: TaskState,
  nodes: BaseNode[],
  existingByKey: Map<string, MemoryChunkPayload>,
  namespace: MemoryNamespaceContext,
): LayeredMemoryCandidate[] {
  const candidates: LayeredMemoryCandidate[] = [];
  const currentTaskSummary = selectCurrentTaskSummary(taskState, existingByKey, nodes, namespace);
  const topDecision = taskState.activeDecisions[0];
  const topConstraint = taskState.constraints[0];
  const topToolFact = taskState.toolFacts[0];

  if (currentTaskSummary || taskState.activeDecisions.length || taskState.openLoops.length) {
    candidates.push({
      title: 'Current Task State',
      summary: currentTaskSummary ?? topDecision ?? taskState.openLoops[0] ?? 'Current task state',
      details: [
        ...taskState.activeDecisions.slice(0, 3).map((value) => `Active decision: ${value}`),
        ...taskState.openLoops.slice(0, 3).map((value) => `Open loop: ${value}`),
      ],
      category: 'current-task',
      scope: 'task',
      persistence: 'task',
      recurrence: 1,
      connectivity: Math.max(2, taskState.activeDecisions.length + taskState.openLoops.length),
      activationEnergy: 'low',
    });
  }

  if (taskState.constraints.length || taskState.toolFacts.length) {
    candidates.push({
      title: 'Current Project State',
      summary: topConstraint ?? topToolFact ?? topDecision ?? taskState.intent ?? 'Current project state',
      details: [
        ...taskState.constraints.slice(0, 3).map((value) => `Constraint: ${value}`),
        ...taskState.toolFacts.slice(0, 3).map((value) => `Tool fact: ${value}`),
      ],
      category: 'current-project',
      scope: 'project',
      persistence: 'task',
      recurrence: 1,
      connectivity: Math.max(2, taskState.constraints.length + taskState.toolFacts.length),
      activationEnergy: 'low',
    });
  }

  for (const patternText of uniqueTexts([
    ...taskState.activeDecisions,
    ...taskState.toolFacts,
    ...taskState.constraints,
  ])) {
    const dedupeKey = createDedupeKey('pattern', patternText, patternText);
    const existingHits = existingByKey.get(dedupeKey)?.hitCount ?? 0;
    if (!matchesAny(REUSABLE_PATTERN_CUES, patternText) && existingHits < 2) {
      continue;
    }

    candidates.push({
      title: summarizeTitle('Reusable Pattern', patternText),
      summary: patternText,
      details: collectRelatedDetails(patternText, nodes),
      category: 'pattern',
      scope: 'workflow',
      persistence: 'project',
      recurrence: Math.max(3, existingHits + 1),
      connectivity: Math.max(3, collectRelatedDetails(patternText, nodes).length + 1),
      activationEnergy: 'medium',
    });
  }

  for (const longTermText of uniqueTexts([
    ...taskState.constraints,
    ...taskState.activeDecisions,
    taskState.intent ?? undefined,
  ])) {
    if (!longTermText || !matchesAny(LONG_TERM_CUES, longTermText)) {
      continue;
    }

    const category = inferColdCategory(longTermText);
    candidates.push({
      title: summarizeTitle(category === 'user-profile' ? 'User Preference' : 'Long-Term Principle', longTermText),
      summary: longTermText,
      details: collectRelatedDetails(longTermText, nodes),
      category,
      scope: category === 'user-profile' ? 'user' : 'system',
      persistence: 'long_term',
      recurrence: Math.max(1, (existingByKey.get(createDedupeKey(category, longTermText, longTermText))?.recurrence ?? 0) + 1),
      connectivity: Math.max(2, collectRelatedDetails(longTermText, nodes).length + 1),
      activationEnergy: 'high',
    });
  }

  candidates.push(...collectUserPreferenceCandidates(nodes, existingByKey));
  candidates.push(...collectAgentExperienceCandidates(nodes, existingByKey));

  return candidates;
}

function collectUserPreferenceCandidates(
  nodes: BaseNode[],
  existingByKey: Map<string, MemoryChunkPayload>,
): LayeredMemoryCandidate[] {
  const userMessages = nodes
    .filter((node) => node.kind === 'message' && (node.payload as { role?: unknown }).role === 'user')
    .map((node) => readNodeText(node))
    .filter((value): value is string => Boolean(value));

  return uniqueTexts(userMessages)
    .filter((text) => !looksLikeSyntheticContextBridgeText(text))
    .filter((text) => looksLikeUserPreference(text))
    .map((text) => {
      const dedupeKey = createDedupeKey('user-profile', text, text);
      const existing = existingByKey.get(dedupeKey);
      return {
        title: summarizeTitle('User Preference', text),
        summary: text,
        details: [text],
        category: 'user-profile',
        scope: 'user',
        persistence: 'long_term',
        recurrence: Math.max(1, (existing?.recurrence ?? 0) + 1),
        connectivity: Math.max(2, (existing?.connectivity ?? 0), 2),
        activationEnergy: 'high',
      };
    });
}

function collectAgentExperienceCandidates(
  nodes: BaseNode[],
  existingByKey: Map<string, MemoryChunkPayload>,
): LayeredMemoryCandidate[] {
  const experienceTexts = nodes
    .filter((node) => node.kind === 'tool_result'
      || (node.kind === 'message' && (node.payload as { role?: unknown }).role === 'assistant'))
    .map((node) => readNodeText(node))
    .filter((value): value is string => Boolean(value) && !looksLikeLowSignalStateNoise(value));

  return uniqueTexts(experienceTexts)
    .filter((text) => !looksLikeSyntheticContextBridgeText(text))
    .filter((text) => matchesAny(REUSABLE_PATTERN_CUES, text))
    .map((text) => {
      const dedupeKey = createDedupeKey('agent-experience', text, text);
      const existing = existingByKey.get(dedupeKey);
      return {
        title: summarizeTitle('Agent Experience', text),
        summary: text,
        details: [text],
        category: 'agent-experience',
        scope: 'workflow',
        persistence: 'project',
        recurrence: Math.max(2, (existing?.recurrence ?? 0) + 1),
        connectivity: Math.max(2, (existing?.connectivity ?? 0), 2),
        activationEnergy: 'medium',
      };
    });
}

function buildDetailLevels(candidate: LayeredMemoryCandidate): {
  abstract: string;
  overview: string;
  detail: string;
} {
  const detailLines = [candidate.summary, ...(candidate.details ?? [])]
    .map((line) => line.trim())
    .filter(Boolean);
  const abstract = sanitizeDetailLine(candidate.summary);
  const overview = uniqueTexts([abstract, ...detailLines.slice(0, 2)]).join('\n');
  const detail = uniqueTexts(detailLines).join('\n');

  return {
    abstract,
    overview: overview || abstract,
    detail: detail || abstract,
  };
}

function buildNowState(
  taskState: TaskState,
  nodes: BaseNode[],
  existingByKey: Map<string, MemoryChunkPayload>,
  now: string,
  namespace: MemoryNamespaceContext,
): NowDocumentState {
  const explicitUserTask = findLatestExplicitTaskDefinition(nodes, 'user');
  const explicitTask = explicitUserTask ?? findLatestExplicitTaskDefinition(nodes);
  const explicitUserNextStep = findLatestExplicitNextStep(nodes, 'user');
  const explicitNextStep = explicitUserNextStep ?? findLatestExplicitNextStep(nodes);
  const currentTask = explicitUserTask
    ?? explicitTask
    ?? (looksLikeRecallIntent(taskState.intent)
      ? selectCurrentTaskSummary(taskState, existingByKey, nodes, namespace) ?? null
      : taskState.intent);
  const blockers = uniqueNowItems(taskState.openLoops)
    .filter((value) => !matchesNowText(value, explicitNextStep))
    .filter((value) => !looksLikeNonActionableStatus(value))
    .filter((value) => !looksLikeCompletedNowAction(value))
    .filter((value) => !looksLikeCompletionEchoPlan(value))
    .filter((value) => !matchesNowText(value, currentTask))
    .slice(0, 4);
  const nextSteps = uniqueNowItems([
    explicitUserNextStep,
    explicitNextStep,
    ...taskState.priorityBacklog,
    ...taskState.openLoops,
  ])
    .filter((value) => !looksLikeNonActionableStatus(value))
    .filter((value) => !matchesNowText(value, currentTask))
    .slice(0, 4);
  const currentPlan = uniqueNowItems(
    taskState.activeDecisions
      .map((value) => compactNowSummary(value, 'plan'))
      .filter((value): value is string => Boolean(value)),
  )
    .filter((value) => !looksLikeNonActionableStatus(value))
    .filter((value) => !looksLikeCompletedNowAction(value))
    .filter((value) => !looksLikeCompletionEchoPlan(value))
    .filter((value) => !matchesNowText(value, currentTask))
    .filter((value) => !nextSteps.some((nextStep) => matchesNowText(value, nextStep)))
    .filter((value) => !blockers.some((blocker) => matchesNowText(value, blocker)))
    .slice(0, 4);

  return {
    currentTask,
    currentPlan,
    blockers,
    nextSteps,
    updatedAt: now,
    lastSessionId: namespace.sessionId,
    lastAgentId: namespace.agentId,
    lastWorkspaceId: namespace.workspaceId,
  };
}

function buildDailyAudit(
  params: RouteLayeredMemoryParams,
  entries: RoutedLayeredMemoryEntry[],
): string[] {
  return [
    `Flush reason: ${params.reason}`,
    params.agentId ? `Agent: ${params.agentId}` : undefined,
    params.workspaceId ? `Workspace: ${params.workspaceId}` : undefined,
    `Intent: ${params.taskState.intent ?? '(unknown)'}`,
    `Wrote layered entries: ${entries.map((entry) => `${entry.layer}:${entry.title}`).join(' | ') || '(none)'}`,
    params.taskState.openLoops.length ? `Open loops: ${params.taskState.openLoops.join(' | ')}` : 'Open loops: none',
  ].filter((line): line is string => Boolean(line));
}

function describeRouteReason(candidate: LayeredMemoryCandidate, layer: MemoryLayer): string {
  if (layer === 'hot') {
    return 'Current task or project state is likely needed again within the next 1-3 steps.';
  }

  if (layer === 'warm') {
    return 'Pattern looks reusable across tasks and should rank above cold background facts.';
  }

  return 'Fact appears stable across sessions and belongs in long-term background memory.';
}

function inferCategory(candidate: LayeredMemoryCandidate, layer: MemoryLayer): string {
  if (layer === 'hot') {
    return candidate.scope === 'project' ? 'current-project' : 'current-task';
  }

  if (layer === 'warm') {
    return matchesAny([/\b(workflow|checklist|playbook)\b/i], candidate.summary) ? 'workflow' : 'pattern';
  }

  return inferColdCategory(candidate.summary);
}

function inferColdCategory(text: string): string {
  if (/\bprefer|preference|user\b/i.test(text) || /偏好|用户/u.test(text)) {
    return 'user-profile';
  }
  if (/\bprinciple|source of truth|always|never\b/i.test(text) || /原则|事实源/u.test(text)) {
    return 'system-principles';
  }
  return 'project-background';
}

function collectRelatedDetails(seed: string, nodes: BaseNode[]): string[] {
  const normalized = seed.toLowerCase();
  return uniqueTexts(
    nodes
      .map((node) => readNodeText(node) ?? JSON.stringify(node.payload))
      .filter((text) => text.toLowerCase().includes(normalized))
      .slice(-3),
  );
}

function summarizeTitle(prefix: string, text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= 72) {
    return `${prefix}: ${compact}`;
  }
  return `${prefix}: ${compact.slice(0, 69)}...`;
}

function createDedupeKey(category: string, title: string, summary: string): string {
  const semanticKey = normalizeMemoryDedupeText(summary || title);
  return slugify(`${category}-${semanticKey}`.slice(0, 140));
}

function resolveNamespaceDirectory(namespace: NamespacePathContext): string {
  const resolved = resolveNamespaceSegments(namespace);
  return `${HYPERGRAPH_MEMORY_ROOT}/${resolved.kind}${resolved.slug ? `/${resolved.slug}` : ''}`;
}

function resolveNamespaceSegments(namespace: NamespacePathContext): { kind: 'session' | 'agent' | 'workspace' | 'global'; slug?: string } {
  const sessionId = readNamespaceSessionId(namespace);
  if (sessionId) {
    return { kind: 'session', slug: slugify(sessionId) };
  }

  const agentId = readNamespaceAgentId(namespace);
  if (agentId) {
    return { kind: 'agent', slug: slugify(agentId) };
  }

  const workspaceId = readNamespaceWorkspaceId(namespace);
  if (workspaceId) {
    return { kind: 'workspace', slug: slugify(workspaceId) };
  }

  return { kind: 'global' };
}

function readNamespaceSessionId(namespace: NamespacePathContext): string | undefined {
  return namespace.sessionId ?? namespace.lastSessionId;
}

function readNamespaceAgentId(namespace: NamespacePathContext): string | undefined {
  return namespace.agentId ?? namespace.lastAgentId;
}

function readNamespaceWorkspaceId(namespace: NamespacePathContext): string | undefined {
  return namespace.workspaceId ?? namespace.lastWorkspaceId;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'memory-entry';
}

function uniqueTexts(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    out.push(normalized);
  }

  return out;
}

function matchesAny(patterns: RegExp[], text: string): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function normalizeMemoryDedupeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\bsource of truth\b/g, 'source-truth')
    .replace(/\bgracefully\b/g, 'graceful')
    .replace(/\breusable\b/g, 'reuse')
    .replace(/\bworkflows?\b/g, 'workflow')
    .replace(/\bpatterns?\b/g, 'pattern')
    .replace(/\bimplemented?\b/g, 'implement')
    .replace(/\bimplementing\b/g, 'implement')
    .replace(/\bupdated?\b/g, 'update')
    .replace(/\bupdating\b/g, 'update')
    .replace(/\bcreated?\b/g, 'create')
    .replace(/\bcreating\b/g, 'create')
    .replace(/\badded?\b/g, 'add')
    .replace(/\badding\b/g, 'add')
    .replace(/\btests?\b/g, 'test')
    .replace(/[^\p{L}\p{N}\s-]+/gu, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
    .slice(0, 12)
    .join(' ');
}

function sanitizeDetailLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function looksLikeUserPreference(text: string): boolean {
  return /\b(i prefer|prefer |please always|always use|never use|reply with|remember that i|for me\b)/i.test(text)
    || /我更喜欢|请始终|请一直|不要用|记住我/u.test(text);
}

function selectCurrentTaskSummary(
  taskState: TaskState,
  existingByKey: Map<string, MemoryChunkPayload>,
  nodes: BaseNode[],
  namespace?: MemoryNamespaceContext,
): string | undefined {
  const explicitTask = findLatestExplicitTaskDefinition(nodes);
  if (explicitTask) {
    return explicitTask;
  }

  if (taskState.intent && !looksLikeRecallIntent(taskState.intent)) {
    return taskState.intent;
  }

  const existingCurrentTask = [...existingByKey.values()]
    .filter((entry) => entry.layer === 'hot' && entry.category === 'current-task')
    .sort((left, right) =>
      namespaceAffinityScore(right, namespace) - namespaceAffinityScore(left, namespace)
      || right.updatedAt.localeCompare(left.updatedAt)
    )[0];

  return existingCurrentTask?.summary
    ?? taskState.activeDecisions[0]
    ?? taskState.openLoops[0]
    ?? undefined;
}

function namespaceAffinityScore(
  entry: MemoryChunkPayload,
  namespace: MemoryNamespaceContext | undefined,
): number {
  if (!namespace) {
    return 0;
  }

  if (namespace.sessionId && entry.lastSessionId === namespace.sessionId) {
    return 3;
  }

  if (namespace.agentId && entry.lastAgentId === namespace.agentId) {
    return 2;
  }

  if (namespace.workspaceId && entry.lastWorkspaceId === namespace.workspaceId) {
    return 1;
  }

  return 0;
}

function findLatestExplicitTaskDefinition(nodes: BaseNode[], role?: 'user' | 'assistant'): string | undefined {
  return [...nodes]
    .reverse()
    .filter((node) => node.kind === 'message' || node.kind === 'intent')
    .filter((node) => !role || readNodeRole(node) === role)
    .map((node) => readNodeText(node))
    .map((value) => extractExplicitTaskDefinition(value))
    .find((value): value is string => Boolean(value));
}

function findLatestExplicitNextStep(nodes: BaseNode[], role?: 'user' | 'assistant'): string | undefined {
  return [...nodes]
    .reverse()
    .filter((node) => node.kind === 'message' || node.kind === 'intent')
    .filter((node) => !role || readNodeRole(node) === role)
    .map((node) => readNodeText(node))
    .map((value) => extractExplicitNextStep(value))
    .find((value): value is string => Boolean(value));
}

function readNodeText(node: BaseNode): string | undefined {
  const payload = node.payload as { text?: unknown; intent?: unknown; question?: unknown; summary?: unknown };
  return [
    payload.text,
    payload.intent,
    payload.question,
    payload.summary,
  ].find((value): value is string =>
    typeof value === 'string'
    && value.trim().length > 0
    && !looksLikeSyntheticContextBridgeText(value),
  );
}

function readNodeRole(node: BaseNode): 'user' | 'assistant' | undefined {
  const payload = node.payload as { role?: unknown };
  const role = typeof payload.role === 'string' ? payload.role.toLowerCase() : undefined;
  if (role === 'user' || role === 'assistant') {
    return role;
  }

  return node.kind === 'intent' ? 'user' : undefined;
}

function looksLikeNonActionableStatus(value: string): boolean {
  const normalized = value.toLowerCase();
  return /\bno active next step\b/.test(normalized)
    || /\btask is done\b/.test(normalized)
    || /\bno remaining issues\b/.test(normalized)
    || /\bstabilization is complete\b/.test(normalized);
}

function looksLikeCompletedNowAction(value: string): boolean {
  const normalized = value.toLowerCase();
  return /(?:^|\s)(?:already\s+)?(?:done|done\.|completed|complete|resolved|finished)(?:$|\s|\))/i.test(normalized)
    || /✅|✔️|☑️/u.test(value);
}

function looksLikeCompletionEchoPlan(value: string): boolean {
  const normalized = value.toLowerCase();
  return /^(stored|saved|remembered|confirmed)\b/.test(normalized)
    || (/\bconfirmed\b/.test(normalized) && /\bwritten\b/.test(normalized))
    || /\bfiles confirmed written\b/.test(normalized);
}

function compactNowSummary(value: string | undefined, kind: 'plan' | 'action'): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value
    .replace(/^\[[^[\]]+\]\s*/u, '')
    .replace(/^<final>\s*/i, '')
    .replace(/\*\*/g, '')
    .replace(/`+/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) {
    return undefined;
  }

  const explicitTask = extractExplicitTaskDefinition(normalized);
  if (explicitTask) {
    return kind === 'plan' ? undefined : stripNowCompletionDecorators(explicitTask);
  }

  const explicitNextStep = extractExplicitNextStep(normalized);
  if (explicitNextStep) {
    return stripNowCompletionDecorators(explicitNextStep);
  }

  const stripped = normalized
    .replace(/^(done|verified|verification complete|update(?:d)?|ready)\.?\s*/i, '')
    .split(/\s+(?:verification results|what was stabilized|files changed|fallback behavior change|problem|solution)\b/i)[0]
    .split(/\s+-\s+/)[0]
    .trim();
  const sentence = stripped
    .split(/(?<=[.!?。！？])\s+/u)[0]
    ?.replace(/[.!?。！？]+$/u, '')
    .trim();

  if (!sentence || sentence.length < 6) {
    return undefined;
  }

  if (looksLikeLowSignalStateNoise(sentence)) {
    return undefined;
  }

  const cleaned = stripNowCompletionDecorators(sentence);
  return cleaned.length > 140 ? `${cleaned.slice(0, 137).trim()}...` : cleaned;
}

function uniqueNowItems(values: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const raw of values) {
    const compacted = compactNowSummary(raw ?? undefined, 'action');
    if (!compacted) {
      continue;
    }

    const key = normalizeNowKey(compacted);
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    out.push(compacted);
  }

  return out;
}

function normalizeNowKey(value: string): string {
  return stripNowCompletionDecorators(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripNowCompletionDecorators(value: string): string {
  return value
    .replace(/[✅✔️☑️]/gu, ' ')
    .replace(/\((?:already\s+)?(?:complete|completed|done|resolved|finished)\)/gi, ' ')
    .replace(/\b(?:already\s+)?(?:complete|completed|done|resolved|finished)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchesNowText(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) {
    return false;
  }

  return normalizeNowKey(left) === normalizeNowKey(right);
}
