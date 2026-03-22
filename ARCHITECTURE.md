# Hypergraph Context Engine - Architecture

## Goal

Build a pluggable OpenClaw context engine that restores task state instead of merely replaying recent history or compressing old messages into a single summary.

The engine keeps the OpenClaw transcript tree as the source of truth and adds semantic/session structure plus layered Markdown memory on top.

## Design principles

- Transcript tree manages time.
- Decision DAG manages dependency.
- Hypergraph manages co-construction.
- Layered memory repository manages durable workspace memory.
- Session state, workspace memory, and runtime bootstrap stay separated.

## Runtime layers

### Layer 1: Transcript tree

- Append-only OpenClaw transcript
- Preserves `id + parentId`
- Remains the only primary session fact source

### Layer 2: Decision DAG

Represents:

- current task
- constraints
- decisions
- tool facts
- artifact states
- open loops

### Layer 3: Hypergraph

Represents:

- multiple evidence supporting one decision
- multiple conditions constituting task state
- multiple inputs updating one artifact
- multiple facts resolving one loop

### Layer 4: Layered memory repository

Represents:

- `NOW.md`, `MEMORY.md`, and `memory/hot|warm|cold|archive|YYYY-MM-DD.md`
- hot/warm/cold routing and lifecycle rules
- workspace-scoped memory recall injected transiently during assemble

## Repository boundaries

```text
src/
  core/
    assemble.ts
    compact.ts
    engine.ts
    ingest.ts
    retriever.ts
    sqlite-store.ts
    task-state.ts
  memory/
    indexer.ts
    lifecycle.ts
    repository.ts
    router.ts
    workspace-store.ts
  plugin/
    config.ts
    index.ts
    openclaw-adapter.ts
    runtime-adapter.ts
tests/
  core/
  memory/
  plugin/
```

Boundary intent:

- `src/core` owns session-local semantic state and persistence.
- `src/memory` owns Markdown memory as a workspace concern.
- `src/plugin` owns OpenClaw integration and config translation.

## Core runtime objects

### Nodes

- MessageNode
- ToolCallNode
- ToolResultNode
- DecisionNode
- ConstraintNode
- IntentNode
- ArtifactSnapshotNode
- MemoryChunkNode
- OpenLoopNode
- SummaryNode

### DAG edge types

- `responds_to`
- `depends_on`
- `derived_from`
- `supersedes`
- `resolves`
- `invalidates`

### Hyperedge types

- `supports(decision)`
- `constitutes(task_state)`
- `updates(artifact)`
- `resolves(loop)`
- `invalidates(old_decision)`

## TaskState

The engine assembles context around an internal `TaskState`, not around raw history.

Fields include:

- `intent`
- `constraints`
- `activeDecisions`
- `candidateDecisions`
- `toolFacts`
- `artifactState`
- `openLoops`
- `relevantMemories`
- `confidence`
- `lastUpdatedAt`

## Lifecycle mapping

### ingest

Responsibilities:

- parse new transcript entries
- extract candidate nodes
- update DAG edges
- refresh task-state materialization inputs

### assemble

Responsibilities:

- identify current task intent
- recover active `TaskState`
- recall graph-local evidence
- query layered memory repository on demand
- rerank, dedupe, and budget-trim
- return ordered messages plus `systemPromptAddition`

### compact

Responsibilities:

- distill state into structured `SummaryNode`
- keep traceable evidence references
- prune older raw nodes conservatively

### afterTurn

Responsibilities:

- optional layered memory flush
- low-priority maintenance hooks
- runtime-safe persistence

## Persistence model

Recommended storage in this prototype:

- SQLite for transcript-derived nodes, edges, summaries, and task state
- Markdown workspace for layered memory facts
- JSON payloads for flexibility
- optional external retrieval index later

Important boundary:

- SQLite does not store workspace memory replicas
- Markdown remains the durable fact source for layered memory
- assemble combines both at read time

## Retrieval model

### Graph recall

Starting from active task/decision/open-loop nodes, expand locally to retrieve:

- active decisions
- valid constraints
- tool facts
- artifact snapshots
- unresolved loops
- connected summary evidence

### Memory recall

Layer-aware retrieval over workspace memory:

- hot first
- warm next
- cold after that
- daily log and archive as lower-priority supplements

### Fusion

Final ranking combines:

- graph score
- lexical retrieval score
- recency
- utility
- redundancy penalty
- layered memory weight

## Current MVP scope

### In scope

- transcript entry ingestion
- node extraction
- lightweight DAG
- `TaskState` materialization
- budgeted assemble
- structured compaction summaries
- hot/warm/cold Markdown memory via repository abstraction
- shared plugin/runtime config normalization

### Out of scope

- deep hyperedge reasoning
- contradiction propagation
- full standalone OpenClaw `memory` slot plugin migration
- external embedding infrastructure as a fact source

## No-risk fallback rule

- if graph state is missing, fall back to transcript + recent history
- if layered memory retrieval fails, assemble still returns valid minimal context
- if compaction fails, do not corrupt transcript or session state

## Next step

The next architecture step is to add a richer retrieval/index backend behind `src/memory/repository.ts` while preserving:

- Markdown as source of truth
- transient memory recall in assemble
- zero duplication of workspace memory into session snapshots
