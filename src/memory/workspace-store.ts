import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import type { MemoryChunkPayload, MemoryLayer } from '../../schemas/types.js';
import type { LayeredMemoryFlushPlan, NowDocumentState, RoutedLayeredMemoryEntry } from './router.js';
import { mergeMemoryEntryState } from './lifecycle.js';
import { resolveMemoryRelativePath } from './router.js';

export interface StoredMemoryEntry extends MemoryChunkPayload {
  relativePath: string;
  content: string;
}

export interface WriteFlushResult {
  writtenFiles: string[];
}

export interface WriteMaintenanceParams {
  entries: StoredMemoryEntry[];
  now?: string;
}

export class LayeredMemoryWorkspaceStore {
  constructor(public readonly rootDir: string) {}

  readEntries(): StoredMemoryEntry[] {
    if (!existsSync(this.rootDir)) {
      return [];
    }

    const files = this.collectMarkdownFiles(this.rootDir);
    const entries = files
      .map((filePath) => this.readEntryFromFile(filePath))
      .filter((value): value is StoredMemoryEntry => Boolean(value));
    const deduped = new Map<string, StoredMemoryEntry>();

    for (const entry of entries) {
      const key = entry.dedupeKey;
      const existing = deduped.get(key);
      if (!existing || entry.updatedAt >= existing.updatedAt) {
        deduped.set(key, entry);
      }
    }

    return [...deduped.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  }

  writeFlush(plan: LayeredMemoryFlushPlan): WriteFlushResult {
    mkdirSync(this.rootDir, { recursive: true });
    const writtenFiles: string[] = [];

    const nowPath = resolve(this.rootDir, 'NOW.md');
    writeFileSync(nowPath, renderNowDocument(plan.nowState), 'utf8');
    writtenFiles.push(relative(this.rootDir, nowPath).replace(/\\/g, '/'));

    const existingByPath = new Map(this.readEntries().map((entry) => [entry.relativePath, entry]));
    const existingByKey = new Map(this.readEntries().map((entry) => [entry.dedupeKey, entry]));

    for (const entry of plan.entries) {
      const nextPath = resolveMemoryRelativePath(entry);
      const incoming: MemoryChunkPayload = {
        ...entry,
        relativePath: undefined,
        details: undefined,
        sourceFile: nextPath,
      } as unknown as MemoryChunkPayload;
      const existing = existingByPath.get(nextPath);
      const merged = mergeMemoryEntryState(existing, incoming, { now: entry.updatedAt });
      const relativePath = resolveMemoryRelativePath({
        layer: merged.layer,
        category: merged.category,
        dedupeKey: merged.dedupeKey,
      });
      const staleEntry = existingByKey.get(merged.dedupeKey);
      if (staleEntry && staleEntry.relativePath !== relativePath) {
        this.deleteIfExists(staleEntry.relativePath);
      }
      const fullPath = resolve(this.rootDir, relativePath);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, renderMemoryEntry({ ...merged, relativePath, content: merged.text ?? merged.summary }), 'utf8');
      writtenFiles.push(relativePath);
    }

    const dailyPath = resolve(this.rootDir, `memory/${plan.nowState.updatedAt.slice(0, 10)}.md`);
    mkdirSync(dirname(dailyPath), { recursive: true });
    if (!existsSync(dailyPath)) {
      writeFileSync(
        dailyPath,
        `---\nlayer: daily_log\nscope: task\nupdated_at: ${plan.nowState.updatedAt}\n---\n# Daily Audit\n`,
        'utf8',
      );
    }
    appendFileSync(dailyPath, `\n## ${plan.nowState.updatedAt}\n${plan.dailyAudit.map((line) => `- ${line}`).join('\n')}\n`, 'utf8');
    writtenFiles.push(relative(this.rootDir, dailyPath).replace(/\\/g, '/'));

    const allEntries = this.readEntries();
    const memoryPath = resolve(this.rootDir, 'MEMORY.md');
    writeFileSync(memoryPath, renderMemoryCoreSummary(allEntries), 'utf8');
    writtenFiles.push('MEMORY.md');

    return { writtenFiles: uniqueStrings(writtenFiles) };
  }

  writeMaintenance(params: WriteMaintenanceParams): WriteFlushResult {
    mkdirSync(this.rootDir, { recursive: true });
    const writtenFiles = this.rewriteLayeredEntries(params.entries);

    return { writtenFiles: uniqueStrings(writtenFiles) };
  }

  private readEntryFromFile(filePath: string): StoredMemoryEntry | undefined {
    const raw = readFileSync(filePath, 'utf8');
    const parsed = parseFrontmatter(raw);
    const stats = statSync(filePath);
    const relativePath = relative(this.rootDir, filePath).replace(/\\/g, '/');
    const layer = inferLayer(relativePath, parsed.frontmatter.layer);
    const updatedAt = asString(parsed.frontmatter.updated_at) ?? stats.mtime.toISOString();

    if (relativePath === 'NOW.md') {
      const nowState = parseNowDocument(parsed.body);
      return {
        layer: 'hot',
        scope: 'task',
        sourceFile: relativePath,
        title: 'Current State',
        summary: nowState.currentTask ?? '(unknown)',
        text: parsed.body.trim(),
        category: 'current-task',
        routeReason: 'Explicit NOW document capturing current state.',
        dedupeKey: 'current-task-state',
        persistence: 'task',
        recurrence: 1,
        connectivity: Math.max(1, nowState.currentPlan.length + nowState.blockers.length + nowState.nextSteps.length),
        activationEnergy: 'low',
        status: 'active',
        updatedAt,
        hitCount: 1,
        sessionCount: 1,
        lastSessionId: asString(parsed.frontmatter.last_session_id),
        lastAgentId: asString(parsed.frontmatter.last_agent_id),
        lastWorkspaceId: asString(parsed.frontmatter.last_workspace_id),
        relativePath,
        content: parsed.body,
      };
    }

    if (relativePath === 'MEMORY.md') {
      return {
        layer: 'memory_core',
        scope: 'system',
        sourceFile: relativePath,
        title: 'Curated Long-Term Memory',
        summary: firstMeaningfulLine(parsed.body) ?? 'Curated memory summary',
        text: parsed.body.trim(),
        category: 'memory-core',
        routeReason: 'Curated long-term memory summary.',
        dedupeKey: 'memory-core-summary',
        persistence: 'long_term',
        recurrence: 1,
        connectivity: 1,
        activationEnergy: 'high',
        status: 'active',
        updatedAt,
        hitCount: 1,
        sessionCount: 1,
        relativePath,
        content: parsed.body,
      };
    }

    return {
      layer,
      scope: inferScope(layer, parsed.frontmatter.scope),
      sourceFile: relativePath,
      title: asString(parsed.frontmatter.title) ?? titleFromPath(relativePath),
      summary: asString(parsed.frontmatter.summary) ?? firstMeaningfulLine(parsed.body) ?? titleFromPath(relativePath),
      text: parsed.body.trim(),
      category: asString(parsed.frontmatter.category) ?? inferCategoryFromPath(relativePath),
      routeReason: asString(parsed.frontmatter.route_reason),
      dedupeKey: asString(parsed.frontmatter.dedupe_key) ?? slugFromPath(relativePath),
      persistence: inferPersistence(asString(parsed.frontmatter.persistence)),
      recurrence: asNumber(parsed.frontmatter.recurrence) ?? 1,
      connectivity: asNumber(parsed.frontmatter.connectivity) ?? 1,
      activationEnergy: inferActivationEnergy(asString(parsed.frontmatter.activation_energy)),
      status: inferStatus(asString(parsed.frontmatter.status)),
      updatedAt,
      firstSeenAt: asString(parsed.frontmatter.first_seen_at),
      hitCount: asNumber(parsed.frontmatter.hit_count) ?? 1,
      sessionCount: asNumber(parsed.frontmatter.session_count) ?? 1,
      lastSessionId: asString(parsed.frontmatter.last_session_id),
      lastAgentId: asString(parsed.frontmatter.last_agent_id),
      lastWorkspaceId: asString(parsed.frontmatter.last_workspace_id),
      relativePath,
      content: parsed.body,
    };
  }

  private collectMarkdownFiles(dir: string): string[] {
    const entries = readdirSync(dir, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'dist') {
        continue;
      }

      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...this.collectMarkdownFiles(fullPath));
        continue;
      }

      if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        files.push(fullPath);
      }
    }

    return files;
  }

  private deleteIfExists(relativePath: string): void {
    const fullPath = resolve(this.rootDir, relativePath);
    if (existsSync(fullPath)) {
      unlinkSync(fullPath);
    }
  }

  private rewriteLayeredEntries(
    entries: StoredMemoryEntry[],
  ): string[] {
    const writtenFiles: string[] = [];
    const managedFiles = this.collectManagedLayerFiles();
    for (const relativePath of managedFiles) {
      this.deleteIfExists(relativePath);
    }

    const persistedEntries = entries
      .filter((entry) => isPersistedLayer(entry.layer))
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));

    for (const entry of persistedEntries) {
      const relativePath = resolveMemoryRelativePath({
        layer: entry.layer,
        category: entry.category,
        dedupeKey: entry.dedupeKey,
      });
      const fullPath = resolve(this.rootDir, relativePath);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(
        fullPath,
        renderMemoryEntry({
          ...entry,
          relativePath,
          sourceFile: relativePath,
          content: entry.content || entry.text || entry.summary,
        }),
        'utf8',
      );
      writtenFiles.push(relativePath);
    }

    const memoryPath = resolve(this.rootDir, 'MEMORY.md');
    writeFileSync(memoryPath, renderMemoryCoreSummary([...entries, ...persistedEntries]), 'utf8');
    writtenFiles.push('MEMORY.md');

    return writtenFiles;
  }

  private collectManagedLayerFiles(): string[] {
    if (!existsSync(this.rootDir)) {
      return [];
    }

    return this.collectMarkdownFiles(this.rootDir)
      .map((filePath) => relative(this.rootDir, filePath).replace(/\\/g, '/'))
      .filter((relativePath) =>
        relativePath.startsWith('memory/hot/')
        || relativePath.startsWith('memory/warm/')
        || relativePath.startsWith('memory/cold/')
        || relativePath.startsWith('memory/archive/'),
      );
  }
}

function isPersistedLayer(layer: MemoryLayer): boolean {
  return layer === 'hot' || layer === 'warm' || layer === 'cold' || layer === 'archive';
}

function renderNowDocument(state: NowDocumentState): string {
  return [
    '---',
    'layer: hot',
    'scope: task',
    `updated_at: ${state.updatedAt}`,
    state.lastSessionId ? `last_session_id: ${sanitizeFrontmatter(state.lastSessionId)}` : undefined,
    state.lastAgentId ? `last_agent_id: ${sanitizeFrontmatter(state.lastAgentId)}` : undefined,
    state.lastWorkspaceId ? `last_workspace_id: ${sanitizeFrontmatter(state.lastWorkspaceId)}` : undefined,
    '---',
    '# Current State',
    '',
    '## Current Task',
    state.currentTask ?? '(unknown)',
    '',
    '## Current Plan',
    ...renderBulletLines(state.currentPlan),
    '',
    '## Blockers',
    ...renderBulletLines(state.blockers),
    '',
    '## Next Steps',
    ...renderBulletLines(state.nextSteps),
    '',
  ].join('\n');
}

function renderMemoryEntry(entry: StoredMemoryEntry): string {
  return [
    '---',
    `layer: ${entry.layer}`,
    `scope: ${entry.scope}`,
    `title: ${sanitizeFrontmatter(entry.title)}`,
    `summary: ${sanitizeFrontmatter(entry.summary)}`,
    entry.category ? `category: ${sanitizeFrontmatter(entry.category)}` : undefined,
    entry.routeReason ? `route_reason: ${sanitizeFrontmatter(entry.routeReason)}` : undefined,
    `dedupe_key: ${entry.dedupeKey}`,
    `persistence: ${entry.persistence}`,
    `recurrence: ${entry.recurrence}`,
    `connectivity: ${entry.connectivity}`,
    `activation_energy: ${entry.activationEnergy}`,
    `status: ${entry.status}`,
    `updated_at: ${entry.updatedAt}`,
    entry.firstSeenAt ? `first_seen_at: ${entry.firstSeenAt}` : undefined,
    typeof entry.hitCount === 'number' ? `hit_count: ${entry.hitCount}` : undefined,
    typeof entry.sessionCount === 'number' ? `session_count: ${entry.sessionCount}` : undefined,
    entry.lastSessionId ? `last_session_id: ${sanitizeFrontmatter(entry.lastSessionId)}` : undefined,
    entry.lastAgentId ? `last_agent_id: ${sanitizeFrontmatter(entry.lastAgentId)}` : undefined,
    entry.lastWorkspaceId ? `last_workspace_id: ${sanitizeFrontmatter(entry.lastWorkspaceId)}` : undefined,
    '---',
    `# ${entry.title}`,
    '',
    entry.summary,
    '',
    entry.content ? entry.content.trim() : '',
    '',
  ]
    .filter((line): line is string => typeof line === 'string')
    .join('\n');
}

function renderMemoryCoreSummary(entries: StoredMemoryEntry[]): string {
  const curated = entries
    .filter((entry) => entry.layer === 'cold')
    .sort((a, b) => (b.hitCount ?? 0) - (a.hitCount ?? 0) || b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 8);

  return [
    '---',
    'layer: memory_core',
    'scope: system',
    `updated_at: ${new Date().toISOString()}`,
    '---',
    '# Curated Long-Term Memory',
    '',
    curated.length
      ? curated.map((entry) => `- ${entry.title}: ${entry.summary}`).join('\n')
      : '- No curated long-term memory yet.',
    '',
  ].join('\n');
}

function parseNowDocument(body: string): NowDocumentState {
  return {
    currentTask: readSectionFirstLine(body, 'Current Task'),
    currentPlan: readSectionBullets(body, 'Current Plan'),
    blockers: readSectionBullets(body, 'Blockers'),
    nextSteps: readSectionBullets(body, 'Next Steps'),
    updatedAt: new Date().toISOString(),
  };
}

function parseFrontmatter(raw: string): { frontmatter: Record<string, string>; body: string } {
  if (!raw.startsWith('---\n')) {
    return { frontmatter: {}, body: raw };
  }

  const end = raw.indexOf('\n---\n', 4);
  if (end < 0) {
    return { frontmatter: {}, body: raw };
  }

  const lines = raw.slice(4, end).split('\n');
  const frontmatter: Record<string, string> = {};
  for (const line of lines) {
    const match = line.match(/^([a-zA-Z0-9_]+):\s*(.*)$/);
    if (!match) {
      continue;
    }
    frontmatter[match[1].toLowerCase()] = match[2];
  }

  return {
    frontmatter,
    body: raw.slice(end + 5),
  };
}

function inferLayer(relativePath: string, explicit: string | undefined): MemoryLayer {
  if (explicit === 'hot' || explicit === 'warm' || explicit === 'cold' || explicit === 'daily_log' || explicit === 'memory_core' || explicit === 'archive') {
    return explicit;
  }
  if (relativePath === 'MEMORY.md') {
    return 'memory_core';
  }
  if (relativePath === 'NOW.md' || relativePath.startsWith('memory/hot/')) {
    return 'hot';
  }
  if (relativePath.startsWith('memory/warm/')) {
    return 'warm';
  }
  if (relativePath.startsWith('memory/cold/')) {
    return 'cold';
  }
  if (relativePath.startsWith('memory/archive/')) {
    return 'archive';
  }
  if (/^memory\/\d{4}-\d{2}-\d{2}\.md$/i.test(relativePath)) {
    return 'daily_log';
  }
  return 'warm';
}

function inferScope(layer: MemoryLayer, explicit: string | undefined): MemoryChunkPayload['scope'] {
  if (explicit === 'task' || explicit === 'project' || explicit === 'workflow' || explicit === 'user' || explicit === 'system') {
    return explicit;
  }
  if (layer === 'hot') {
    return 'task';
  }
  if (layer === 'warm') {
    return 'workflow';
  }
  return 'system';
}

function inferPersistence(value: string | undefined): MemoryChunkPayload['persistence'] {
  if (value === 'turn' || value === 'task' || value === 'project' || value === 'long_term') {
    return value;
  }
  return 'project';
}

function inferActivationEnergy(value: string | undefined): MemoryChunkPayload['activationEnergy'] {
  if (value === 'low' || value === 'medium' || value === 'high') {
    return value;
  }
  return 'medium';
}

function inferStatus(value: string | undefined): MemoryChunkPayload['status'] {
  if (value === 'active' || value === 'archived' || value === 'invalidated') {
    return value;
  }
  return 'active';
}

function inferCategoryFromPath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/');
  if (normalized.startsWith('memory/hot/current-project')) {
    return 'current-project';
  }
  if (normalized.startsWith('memory/hot/current-task')) {
    return 'current-task';
  }
  return slugFromPath(normalized);
}

function titleFromPath(relativePath: string): string {
  return relativePath
    .split('/')
    .at(-1)
    ?.replace(/\.md$/i, '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase()) ?? 'Memory Entry';
}

function slugFromPath(relativePath: string): string {
  return relativePath
    .replace(/\\/g, '/')
    .split('/')
    .at(-1)
    ?.replace(/\.md$/i, '') ?? 'memory-entry';
}

function readSectionFirstLine(body: string, section: string): string | null {
  const text = readSection(body, section)
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);

  return text ?? null;
}

function readSectionBullets(body: string, section: string): string[] {
  return readSection(body, section)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
}

function readSection(body: string, section: string): string {
  const match = body.match(new RegExp(`## ${escapeRegex(section)}\\n([\\s\\S]*?)(?=\\n## |$)`));
  return match?.[1]?.trim() ?? '';
}

function firstMeaningfulLine(body: string): string | undefined {
  return body
    .split('\n')
    .map((line) => line.trim())
    .find((line) => Boolean(line) && !line.startsWith('#') && !line.startsWith('- '));
}

function renderBulletLines(values: string[]): string[] {
  return values.length ? values.map((value) => `- ${value}`) : ['- none'];
}

function sanitizeFrontmatter(value: string): string {
  return value.replace(/\n+/g, ' ').trim();
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }

  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
