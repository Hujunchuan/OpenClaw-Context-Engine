import type {
  BaseNode,
  FlushReason,
  MemoryChunkPayload,
  MemoryLayer,
  MemoryScope,
  TaskState,
} from '../../schemas/types.js';

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
}

export interface LayeredMemoryFlushPlan {
  nowState: NowDocumentState;
  entries: RoutedLayeredMemoryEntry[];
  dailyAudit: string[];
}

export interface RouteLayeredMemoryParams {
  sessionId: string;
  taskState: TaskState;
  nodes: BaseNode[];
  existingEntries?: MemoryChunkPayload[];
  reason: FlushReason;
  now?: string;
}

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
  const candidates = collectCandidates(params.taskState, params.nodes, existingByKey);
  const entries = candidates.map((candidate) => {
    const routed = routeMemoryCandidate(candidate);
    const existing = existingByKey.get(routed.dedupeKey);
    const recurrence = Math.max(routed.recurrence, (existing?.recurrence ?? 0) + 1);
    const connectivity = Math.max(routed.connectivity, existing?.connectivity ?? 0);
    const hitCount = (existing?.hitCount ?? 0) + 1;
    const sessionCount = existing?.lastSessionId === params.sessionId ? existing?.sessionCount ?? 1 : (existing?.sessionCount ?? 0) + 1;

    return {
      ...routed,
      updatedAt: now,
      firstSeenAt: existing?.firstSeenAt ?? now,
      hitCount,
      sessionCount,
      recurrence,
      connectivity,
      lastSessionId: params.sessionId,
      relativePath: resolveMemoryRelativePath({
        layer: routed.layer,
        category: routed.category,
        dedupeKey: routed.dedupeKey,
      }),
    };
  });

  return {
    nowState: buildNowState(params.taskState, now),
    entries,
    dailyAudit: buildDailyAudit(params, entries),
  };
}

export function routeMemoryCandidate(candidate: LayeredMemoryCandidate): RoutedLayeredMemoryEntry {
  const layer = classifyMemoryLayer(candidate);
  const category = candidate.category ?? inferCategory(candidate, layer);
  const dedupeKey = createDedupeKey(category, candidate.title, candidate.summary);

  const entry: RoutedLayeredMemoryEntry = {
    layer,
    scope: candidate.scope,
    sourceFile: '',
    title: candidate.title,
    summary: candidate.summary,
    text: [candidate.summary, ...(candidate.details ?? [])].join('\n'),
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

export function resolveMemoryRelativePath(entry: Pick<RoutedLayeredMemoryEntry, 'layer' | 'category' | 'dedupeKey'>): string {
  if (entry.layer === 'hot') {
    if (entry.category === 'current-project') {
      return 'memory/hot/current-project.md';
    }

    return 'memory/hot/current-task.md';
  }

  if (entry.layer === 'warm') {
    const slug = slugify(`${entry.category ?? 'pattern'}-${entry.dedupeKey}`);
    return `memory/warm/${slug}.md`;
  }

  if (entry.layer === 'cold') {
    const category = entry.category ?? 'project-background';
    const slug = slugify(`${category}-${entry.dedupeKey}`);
    return `memory/cold/${slug}.md`;
  }

  if (entry.layer === 'archive') {
    return `memory/archive/${slugify(entry.dedupeKey)}.md`;
  }

  if (entry.layer === 'daily_log') {
    return `memory/${new Date().toISOString().slice(0, 10)}.md`;
  }

  return 'MEMORY.md';
}

function collectCandidates(
  taskState: TaskState,
  nodes: BaseNode[],
  existingByKey: Map<string, MemoryChunkPayload>,
): LayeredMemoryCandidate[] {
  const candidates: LayeredMemoryCandidate[] = [];
  const topDecision = taskState.activeDecisions[0];
  const topConstraint = taskState.constraints[0];
  const topToolFact = taskState.toolFacts[0];

  if (taskState.intent || taskState.activeDecisions.length || taskState.openLoops.length) {
    candidates.push({
      title: 'Current Task State',
      summary: taskState.intent ?? topDecision ?? taskState.openLoops[0] ?? 'Current task state',
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

  return candidates;
}

function buildNowState(taskState: TaskState, now: string): NowDocumentState {
  return {
    currentTask: taskState.intent,
    currentPlan: taskState.activeDecisions.slice(0, 4),
    blockers: taskState.openLoops.slice(0, 4),
    nextSteps: taskState.priorityBacklog.slice(0, 4),
    updatedAt: now,
  };
}

function buildDailyAudit(
  params: RouteLayeredMemoryParams,
  entries: RoutedLayeredMemoryEntry[],
): string[] {
  return [
    `Flush reason: ${params.reason}`,
    `Intent: ${params.taskState.intent ?? '(unknown)'}`,
    `Wrote layered entries: ${entries.map((entry) => `${entry.layer}:${entry.title}`).join(' | ') || '(none)'}`,
    params.taskState.openLoops.length ? `Open loops: ${params.taskState.openLoops.join(' | ')}` : 'Open loops: none',
  ];
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
      .map((node) => JSON.stringify(node.payload))
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
