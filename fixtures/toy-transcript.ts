import type { TranscriptEntryLike } from '../src/engine.js';

export const toySessionId = 'toy-session';

export const toyTranscript: TranscriptEntryLike[] = [
  {
    id: 'u1',
    role: 'user',
    content:
      'Build the Hypergraph Context Engine MVP. Priority: 1) src/task-state.ts 2) src/ingest.ts 3) src/assemble.ts. Please keep the transcript as source of truth.',
    createdAt: '2026-03-21T16:00:00.000Z',
  },
  {
    id: 'a1',
    role: 'assistant',
    content: 'I will implement task-state materialization first, then ingest heuristics, then assemble buckets.',
    createdAt: '2026-03-21T16:01:00.000Z',
  },
  {
    id: 't1',
    role: 'assistant',
    type: 'tool_result',
    toolName: 'read',
    content: 'ARCHITECTURE.md confirms transcript tree remains source of truth and assemble should degrade gracefully.',
    createdAt: '2026-03-21T16:02:00.000Z',
  },
  {
    id: 'a2',
    role: 'assistant',
    content: 'Added src/task-state.ts and src/ingest.ts. Next step: wire src/assemble.ts and prepare a toy demo fixture.',
    createdAt: '2026-03-21T16:03:00.000Z',
  },
  {
    id: 'u2',
    role: 'user',
    content: 'Great. Also leave a clear open loop for SQLite storage later?',
    createdAt: '2026-03-21T16:04:00.000Z',
  },
];
