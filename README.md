# OpenClaw Context Engine

Hypergraph Context Engine MVP skeleton for OpenClaw.

## Current MVP progress

Implemented:
- `src/task-state.ts` - TaskState materialization helpers, now distinguishing unresolved vs resolved historical open loops via graph edges
- `src/ingest.ts` - transcript ingestion + heuristic node extraction
- `src/retriever.ts` - minimal retrieval abstraction and relevance scoring
- `src/assemble.ts` - score, bucket, and assemble compact context
- `src/compact.ts` - structured `SummaryNode` emission with carried-forward open loops
- `src/sqlite-store.ts` - minimal SQLite persistence for transcript / nodes / edges / task state
- `src/engine.ts` - in-memory orchestration wrapper, now with `ingestMany()` + one-shot `ingestAndAssemble()` demo path
- `fixtures/toy-transcript.ts` - minimal reusable toy transcript fixture
- `fixtures/branching-transcript.ts` - richer branching transcript fixture with explicit parent links and follow-up loops
- `fixtures/toy-demo.ts` - end-to-end ingest → assemble → compact demo across both fixtures

Current behavior is intentionally conservative:
- transcript remains the source of truth
- extraction is heuristic and explainable
- assemble degrades to valid empty output when no state exists
- compaction emits a traceable summary payload instead of only freeform notes
- SQLite persistence now exists as a separate MVP store layer; retrieval still runs in-process and richer hyperedge reasoning remains TODO

## Quick start

```bash
npm install
npm run check
npm run test
npm run demo
```

The demo prints, for both the minimal and branching fixtures:
- assembled context messages
- recovered `taskState`
- assemble bucket summary metadata
- top retrieval explanation metadata (`retrievalSummary`) showing why candidate nodes were selected
- heuristic graph edges created during ingest (useful for debugging `resolves` / `depends_on` / `supersedes` behavior)
- the compact result metadata
- the generated structured summary node
- the stored session ids for the scenario

## Known TODOs

- replace token-overlap heuristics with proper lexical / embedding retrieval
- promote current heuristic relation edges into richer hyperedges once the schema and reasoning path are ready
- distinguish "still-open" vs "resolved but historically relevant" loops more explicitly during task-state materialization
tly during task-state materialization
