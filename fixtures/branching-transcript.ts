import type { TranscriptEntryLike } from '../src/core/engine.js';

export const branchingSessionId = 'branching-toy-session';

export const branchingTranscript: TranscriptEntryLike[] = [
  {
    id: 'u1',
    role: 'user',
    content:
      'Design a toy transcript demo for the Hypergraph Context Engine. Must keep the transcript as source of truth and show why retrieval picked each node.',
    createdAt: '2026-03-22T00:00:00.000Z',
  },
  {
    id: 'a1',
    parentId: 'u1',
    role: 'assistant',
    content:
      'I will first add a branching fixture, then update the demo output, and finally add regression tests so this stays explainable.',
    createdAt: '2026-03-22T00:01:00.000Z',
  },
  {
    id: 'tc1',
    parentId: 'a1',
    role: 'assistant',
    type: 'tool_call',
    toolName: 'read',
    content: 'Read README.md and ARCHITECTURE.md to confirm demo goals and guardrails.',
    createdAt: '2026-03-22T00:02:00.000Z',
  },
  {
    id: 'tr1',
    parentId: 'tc1',
    role: 'assistant',
    type: 'tool_result',
    toolName: 'read',
    content:
      'README says the demo should show assembled context, recovered task state, bucket summary metadata, and retrieval explanation metadata.',
    createdAt: '2026-03-22T00:02:30.000Z',
  },
  {
    id: 'u2',
    parentId: 'a1',
    role: 'user',
    content:
      'Nice. Also add fixtures for a follow-up branch and leave an explicit open loop for golden regression snapshots later?',
    createdAt: '2026-03-22T00:03:00.000Z',
  },
  {
    id: 'a2',
    parentId: 'u2',
    role: 'assistant',
    content:
      'Added fixtures/toy-transcript.ts and fixtures/branching-transcript.ts. Next step: wire demo snapshots and decide whether golden fixtures should live in tests/fixtures.',
    createdAt: '2026-03-22T00:04:00.000Z',
  },
  {
    id: 'u3',
    parentId: 'a2',
    role: 'user',
    content: 'Please prefer smaller but stable fixtures so the regression output stays readable.',
    createdAt: '2026-03-22T00:05:00.000Z',
  },
];
