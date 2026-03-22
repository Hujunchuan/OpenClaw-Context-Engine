import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { BaseNode, GraphEdge, Hyperedge, TaskState } from '../../schemas/types.js';
import type { SessionSnapshot } from './ingest.js';
import type { TranscriptEntryLike } from './engine.js';

export interface PersistableSessionSnapshot extends SessionSnapshot {
  taskState?: TaskState;
  hyperedges?: Hyperedge[];
}

interface SessionRow {
  session_id: string;
  updated_at: string;
}

interface JsonRow {
  json: string;
}

export class SQLiteStore {
  private readonly db: DatabaseSync;

  constructor(public readonly filename: string = ':memory:') {
    if (filename !== ':memory:') {
      mkdirSync(dirname(filename), { recursive: true });
    }

    this.db = new DatabaseSync(filename);
    this.migrate();
  }

  migrate(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transcript_entries (
        session_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (session_id, entry_id)
      );
      CREATE TABLE IF NOT EXISTS nodes (
        session_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        created_at TEXT NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (session_id, node_id)
      );
      CREATE TABLE IF NOT EXISTS edges (
        session_id TEXT NOT NULL,
        edge_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        created_at TEXT NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (session_id, edge_id)
      );
      CREATE TABLE IF NOT EXISTS hyperedges (
        session_id TEXT NOT NULL,
        hyperedge_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        created_at TEXT NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (session_id, hyperedge_id)
      );
      CREATE TABLE IF NOT EXISTS task_states (
        session_id TEXT PRIMARY KEY,
        updated_at TEXT NOT NULL,
        json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_nodes_session_kind_created_at ON nodes(session_id, kind, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_edges_session_kind_created_at ON edges(session_id, kind, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_transcript_entries_session_created_at ON transcript_entries(session_id, created_at DESC);
    `);
  }

  saveSession(snapshot: PersistableSessionSnapshot): void {
    const now = snapshot.taskState?.lastUpdatedAt ?? new Date().toISOString();
    const upsertSession = this.db.prepare(`
      INSERT INTO sessions (session_id, updated_at)
      VALUES (?, ?)
      ON CONFLICT(session_id) DO UPDATE SET updated_at = excluded.updated_at
    `);
    const upsertTranscript = this.db.prepare(`
      INSERT INTO transcript_entries (session_id, entry_id, created_at, json)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id, entry_id) DO UPDATE SET created_at = excluded.created_at, json = excluded.json
    `);
    const upsertNode = this.db.prepare(`
      INSERT INTO nodes (session_id, node_id, kind, created_at, json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id, node_id) DO UPDATE SET kind = excluded.kind, created_at = excluded.created_at, json = excluded.json
    `);
    const upsertEdge = this.db.prepare(`
      INSERT INTO edges (session_id, edge_id, kind, created_at, json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id, edge_id) DO UPDATE SET kind = excluded.kind, created_at = excluded.created_at, json = excluded.json
    `);
    const upsertHyperedge = this.db.prepare(`
      INSERT INTO hyperedges (session_id, hyperedge_id, kind, created_at, json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id, hyperedge_id) DO UPDATE SET kind = excluded.kind, created_at = excluded.created_at, json = excluded.json
    `);
    const upsertTaskState = this.db.prepare(`
      INSERT INTO task_states (session_id, updated_at, json)
      VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET updated_at = excluded.updated_at, json = excluded.json
    `);

    this.db.exec('BEGIN');
    try {
      upsertSession.run(snapshot.sessionId, now);

      for (const entry of snapshot.transcriptEntries) {
        upsertTranscript.run(snapshot.sessionId, entry.id, entry.createdAt ?? now, JSON.stringify(entry));
      }

      for (const node of snapshot.nodes) {
        upsertNode.run(snapshot.sessionId, node.id, node.kind, node.createdAt, JSON.stringify(node));
      }

      for (const edge of snapshot.edges) {
        upsertEdge.run(snapshot.sessionId, edge.id, edge.kind, edge.createdAt, JSON.stringify(edge));
      }

      for (const hyperedge of snapshot.hyperedges ?? []) {
        upsertHyperedge.run(snapshot.sessionId, hyperedge.id, hyperedge.kind, hyperedge.createdAt, JSON.stringify(hyperedge));
      }

      if (snapshot.taskState) {
        upsertTaskState.run(snapshot.sessionId, snapshot.taskState.lastUpdatedAt, JSON.stringify(snapshot.taskState));
      }

      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  loadSession(sessionId: string): PersistableSessionSnapshot | undefined {
    const exists = this.db.prepare('SELECT session_id, updated_at FROM sessions WHERE session_id = ?').get(sessionId) as SessionRow | undefined;
    if (!exists) {
      return undefined;
    }

    const transcriptEntries = this.readJsonRows<TranscriptEntryLike>(
      'SELECT json FROM transcript_entries WHERE session_id = ? ORDER BY created_at ASC, entry_id ASC',
      sessionId,
    );
    const nodes = this.readJsonRows<BaseNode>('SELECT json FROM nodes WHERE session_id = ? ORDER BY created_at ASC, node_id ASC', sessionId);
    const edges = this.readJsonRows<GraphEdge>('SELECT json FROM edges WHERE session_id = ? ORDER BY created_at ASC, edge_id ASC', sessionId);
    const hyperedges = this.readJsonRows<Hyperedge>(
      'SELECT json FROM hyperedges WHERE session_id = ? ORDER BY created_at ASC, hyperedge_id ASC',
      sessionId,
    );
    const taskStateRow = this.db.prepare('SELECT json FROM task_states WHERE session_id = ?').get(sessionId) as JsonRow | undefined;

    return {
      sessionId,
      transcriptEntries,
      nodes,
      edges,
      hyperedges,
      taskState: taskStateRow ? (JSON.parse(taskStateRow.json) as TaskState) : undefined,
    };
  }

  listSessionIds(): string[] {
    return (this.db.prepare('SELECT session_id FROM sessions ORDER BY updated_at DESC').all() as Array<{ session_id: string }>).map(
      (row) => row.session_id,
    );
  }

  close(): void {
    this.db.close();
  }

  private readJsonRows<T>(sql: string, sessionId: string): T[] {
    const rows = this.db.prepare(sql).all(sessionId) as unknown as JsonRow[];
    return rows.map((row) => JSON.parse(row.json) as T);
  }
}

export interface SQLiteStoreTodo {
  title: string;
  status: 'todo' | 'blocked' | 'done';
  note: string;
}

export const SQLITE_STORE_TODOS: SQLiteStoreTodo[] = [
  {
    title: 'Add FTS / semantic retrieval index',
    status: 'todo',
    note: 'Current MVP stores canonical JSON rows only; retrieval still runs in process over loaded nodes.',
  },
  {
    title: 'Persist hyperedge inference beyond explicit inputs',
    status: 'todo',
    note: 'Hyperedge table exists, but automatic hyperedge generation is still intentionally conservative.',
  },
  {
    title: 'Add snapshot compaction / archival policy',
    status: 'todo',
    note: 'Rows are append-friendly and upsert-safe, but branch archival remains a higher-level runtime concern.',
  },
];
