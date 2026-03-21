# Hypergraph Context Engine - MVP Plan

## Phase 1: Skeleton

### Deliverables
- directory structure
- type definitions
- storage abstraction
- lifecycle skeleton (`ingest`, `assemble`, `compact`, `afterTurn`)
- no-op safe fallback behavior

### Success criteria
- compiles
- does not break session flow
- can accept transcript entries and persist extracted nodes

## Phase 2: Basic State Recovery

### Deliverables
- `TaskState` materializer
- basic node extraction rules
- graph recall from active intent / decisions / open loops
- assemble budget buckets
- short `systemPromptAddition`

### Success criteria
- can recover task intent / constraints / tool facts for realistic sessions
- can assemble a smaller and more useful context package than recent-history-only strategy

## Phase 3: Structured Compaction

### Deliverables
- branch archive detection
- state distillation
- `SummaryNode` emission
- stale branch demotion

### Success criteria
- old branches become structured summaries
- future assemble can use summaries instead of replaying all old transcript

## Phase 4: Hyperedges

### Deliverables
- support `supports(decision)`
- support `constitutes(task_state)`
- support `updates(artifact)`
- hyperedge scoring + revalidation

### Success criteria
- multi-evidence task state recovery works better than DAG-only recall

## Phase 5: Memory + Cross-session Integration

### Deliverables
- memory chunk normalization
- session chunk normalization
- hybrid search fusion
- confidence-aware merge into `TaskState`

### Success criteria
- engine can pull useful evidence from both memory and session-derived chunks

## Guardrails

- transcript remains source of truth
- index corruption must not block normal chat
- engine failures degrade gracefully to recent history
- compaction outputs must be traceable back to transcript ids
- no hidden mutation of original transcript content

## Immediate Coding Order

1. `schemas/types.ts`
2. `src/task-state.ts`
3. `src/sqlite-store.ts`
4. `src/ingest.ts`
5. `src/retriever.ts`
6. `src/assemble.ts`
7. `src/compact.ts`
8. `src/engine.ts`

## First Demo Target

Given a toy transcript with:
- a user request
- 2 constraints
- 1 tool call + result
- 1 assistant decision
- 1 unresolved follow-up

the engine should:
- ingest all entries
- produce a `TaskState`
- assemble a compact context package
- emit a structured `SummaryNode` after compaction

## Current status snapshot

Done:
- task-state materialization
- transcript ingest + heuristic semantic node extraction
- assemble scoring + budget buckets
- end-to-end toy transcript / demo fixture
- structured compaction summary node

Still next:
- richer retrieval (FTS/vector/MMR) beyond in-process scoring
- richer hyperedge support
- golden regression snapshots / evaluation harness on top of the new branching fixtures
- compaction archival policy / stale branch handling beyond summary emission

Recently added:
- `assemble()` now exposes a small `retrievalSummary` debug surface so demos/tests can inspect why top nodes were selected without digging through internal scorer state
- a richer branching transcript fixture now exercises explicit `parentId` links, follow-up open loops, and demo-friendly regression coverage
