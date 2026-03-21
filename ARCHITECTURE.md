# Hypergraph Context Engine - Architecture

## Goal

Build a pluggable OpenClaw context engine that restores *task state* instead of merely replaying recent history or compressing old messages into a single summary.

The engine keeps OpenClaw transcript tree as the source of truth and adds two semantic layers on top:

1. **Decision DAG** - lightweight dependency and state graph
2. **Hypergraph** - multi-evidence / multi-condition semantic relations

## Design Principle

- **Transcript Tree manages time**
- **Decision DAG manages dependency**
- **Hypergraph manages co-construction**

## Core Layers

### Layer 1: Transcript Tree
- Reuse append-only OpenClaw transcript
- Preserve `id + parentId`
- Keep as only primary fact source

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

## Core Runtime Objects

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
- responds_to
- depends_on
- derived_from
- supersedes
- resolves
- invalidates

### Hyperedge types
- supports(decision)
- constitutes(task_state)
- updates(artifact)
- resolves(loop)
- invalidates(old_decision)

## TaskState

The engine assembles context around an internal `TaskState`, not around raw history.

Fields:
- `intent`
- `constraints`
- `active_decisions`
- `candidate_decisions`
- `tool_facts`
- `artifact_state`
- `open_loops`
- `relevant_memories`
- `confidence`
- `last_updated_at`

## OpenClaw Lifecycle Mapping

### ingest
Responsibilities:
- parse new transcript entries
- extract candidate nodes
- update Decision DAG
- create/update hyperedges when obvious
- refresh task state cache
- update retrieval index

### assemble
Responsibilities:
- identify current task intent
- recover active `TaskState`
- graph recall from DAG / Hypergraph
- semantic recall from memory + session index
- dedupe / rerank / budget trim
- produce ordered messages
- produce `systemPromptAddition`

### compact
Responsibilities:
- branch archive
- state distillation
- hyperedge consolidation
- stale edge invalidation
- `SummaryNode` generation

### afterTurn
Responsibilities:
- async reindex
- stale-score updates
- low-priority hyperedge merge
- metrics logging

## Retrieval Strategy

### Graph recall
Starting from active task / decision / open loop nodes, expand locally to retrieve:
- active decisions
- valid constraints
- tool facts
- artifact snapshots
- unresolved loops
- connected high-value hyperedges

### Semantic recall
Hybrid retrieval over memory + session-derived chunks:
- keyword / BM25
- vector similarity
- MMR deduplication
- temporal decay

### Fusion score

`FinalScore = α*GraphScore + β*RetrievalScore + γ*RecencyScore + δ*UtilityScore - ε*RedundancyPenalty`

## Assemble Budget Buckets

Suggested buckets:
- RecentDialogueBucket
- TaskStateBucket
- EvidenceBucket
- ArtifactBucket
- MemoryPatchBucket

## Compaction Output

Compaction should produce structured `SummaryNode` objects, not only freeform summary text.

Suggested fields:
- `summary_id`
- `branch_root`
- `intent`
- `constraints`
- `final_decisions`
- `evidence_refs`
- `artifact_final_state`
- `open_loops_remaining`
- `valid_until`
- `confidence`

## Storage Recommendation for MVP

Use a separate index layer instead of modifying transcript storage.

Recommended MVP storage:
- SQLite for nodes / edges / summaries / task states
- JSON blobs for flexible payloads
- optional later vector index

## MVP Scope

### In scope
- transcript entry ingestion
- node extraction
- lightweight Decision DAG
- `TaskState` cache
- simple graph recall
- simple semantic recall abstraction
- budgeted assemble
- structured compaction summaries

### Out of scope for MVP
- full hyperedge reasoning
- full contradiction propagation
- automatic deep subagent result normalization
- hot/warm/cold memory tiering
- advanced embedding infra

## Recommended Repository Shape

```text
hypergraph-context-engine/
  ARCHITECTURE.md
  mvp-plan.md
  schemas/
    types.ts
  src/
    engine.ts
    ingest.ts
    assemble.ts
    compact.ts
    retriever.ts
    task-state.ts
    scorer.ts
    sqlite-store.ts
```

## Next Step

Implement a skeleton engine with no-risk fallbacks:
- if graph state is missing, fall back to transcript + recent history
- if retrieval fails, assemble should still produce a valid minimal context
- if compaction fails, do not corrupt transcript or session state
