# OpenClaw Context Engine

Hypergraph Context Engine MVP skeleton for OpenClaw.

## Current MVP progress

Implemented:
- `src/task-state.ts` - TaskState materialization helpers, now distinguishing unresolved vs resolved historical open loops via graph edges, filtering superseded decisions out of `activeDecisions`, reconciling compact-summary open loops against semantically similar resolved loops, suppressing resolved-loop history again when a later follow-up explicitly reopens the same topic, recovering state from compact summary nodes when raw history is sparse, preferring non-expired summaries over stale compacted ones, normalizing duplicate tool facts into a single canonical fact, dropping constraints that merely duplicate the selected top-level intent, deriving an ordered priority backlog from the latest numbered user list while automatically skipping items already covered by decisions / explicit open loops / resolved history, and exposing ordered `priorityStatus` state (`pending` / `active` / `open_loop` / `resolved`) so downstream assembly/compaction can see progress against the latest explicit priority list instead of only the leftover backlog; concrete artifact evidence now upgrades a covered priority item from merely `active` to `resolved`
- `src/ingest.ts` - transcript ingestion + heuristic node extraction, with narrower artifact detection so generic user goals / priority lists do not automatically pollute artifact state while concrete file-oriented hints still survive; assistant progress updates that include `Next step:` / `TODO:` / `Blocked on:` now trim open-loop extraction down to the actionable follow-up clause instead of duplicating the whole status sentence, while still preserving the fuller raw status text for relation scoring / artifact detail; explicit completion cues (`done` / `finished` / `resolved`) now mint resolve-worthy decision nodes for follow-up closure and later related open loops can mark the old resolved loop as reopened via `invalidates`; successful `tool_result` output for commit/demo/compact/push steps now also emits progress decisions so task-state can recover those milestones from actual command output instead of only assistant narration
- `src/retriever.ts` - minimal retrieval abstraction and relevance scoring
- `src/assemble.ts` - score, bucket, and assemble compact context, now seeding each bucket with its top-ranked candidate when budget allows so task-state / artifact evidence is less likely to disappear under recency-heavy scoring
- `src/compact.ts` - structured `SummaryNode` emission plus minimal snapshot compaction that trims older raw transcript/message nodes while preserving semantic state, persisting candidate decisions + tool facts into summary payloads, keeping open-loop / artifact evidence refs attached for post-compact re-assembly, and injecting a fresher forward-looking TODO instead of a stale hardcoded SQLite reminder
- `src/sqlite-store.ts` - minimal SQLite persistence for transcript / nodes / edges / task state
- `src/engine.ts` - in-memory orchestration wrapper, now with `ingestMany()` + one-shot `ingestAndAssemble()` demo path
- `fixtures/toy-transcript.ts` - minimal reusable toy transcript fixture
- `fixtures/branching-transcript.ts` - richer branching transcript fixture with explicit parent links and follow-up loops
- `fixtures/demo-scenarios.ts` - reusable end-to-end scenario runner that returns stable fixture snapshots for demos and regression tests
- `fixtures/toy-demo.ts` - end-to-end ingest → assemble → compact demo across both fixtures

Current behavior is intentionally conservative:
- transcript remains the source of truth
- extraction is heuristic and explainable
- assemble degrades to valid empty output when no state exists
- compaction now emits a traceable summary payload and prunes older raw transcript/message/tool nodes under a small retention budget
- SQLite persistence now exists as a separate MVP store layer; retrieval still runs in-process and richer hyperedge reasoning remains TODO

## Quick start

```bash
npm install
npm run check
npm run test
npm run demo
npm run demo:snapshots
```

The demo prints, for both the minimal and branching fixtures:
- assembled context message kinds + recovered `taskState` (including ordered `priorityStatus` alongside the remaining `priorityBacklog`)
- assemble bucket summary metadata
- top retrieval explanation metadata (`retrievalSummary`) showing why candidate nodes were selected
- heuristic graph edge counts created during ingest (useful for debugging `resolves` / `depends_on` / `supersedes` behavior)
- the compact result metadata + normalized summary payload
- a post-compact re-assemble pass, to show that summary-backed recovery still returns usable context
- the stored session ids for the scenario

`npm run demo:snapshots` emits the same scenario data as machine-readable JSON so regression tests can reuse the exact fixture runner instead of maintaining a second golden-path implementation.

## Known TODOs

- replace token-overlap heuristics with proper lexical / embedding retrieval
- promote current heuristic relation edges into richer hyperedges once the schema and reasoning path are ready
- replace fixed retention heuristics in compact with branch-aware archival / TTL policies
- shrink artifact extraction noise further for non-English / mixed-language transcripts
