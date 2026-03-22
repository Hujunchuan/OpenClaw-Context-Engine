# OpenClaw Plugin Integration Plan

## Goal

Bridge the existing Hypergraph Context Engine prototype into OpenClaw's pluggable context-engine lifecycle without rewriting the core prototype logic.

This document defines the **adapter layer** between:
- the current prototype repository logic (`src/ingest.ts`, `src/assemble.ts`, `src/compact.ts`, `src/task-state.ts`)
- OpenClaw runtime lifecycle hooks (`ingest`, `assemble`, `compact`, `afterTurn`)

## Current Prototype Status

Already implemented in the prototype:
- transcript ingestion
- heuristic semantic node extraction
- lightweight graph edges
- `TaskState` materialization
- bucketed assemble
- structured compaction summary node
- retrieval scoring
- SQLite persistence abstraction
- readable demos + regression tests

## Integration Strategy

### Rule 1: Keep transcript as source of truth
OpenClaw transcript storage remains canonical.
The plugin only builds a secondary semantic index layer.

### Rule 2: Use an adapter, not a rewrite
The prototype repository should remain the place where semantic logic evolves.
OpenClaw integration should wrap that logic instead of duplicating it.

### Rule 3: Fail safely
If the hypergraph adapter fails:
- do not corrupt transcript state
- do not block the chat turn
- fall back to recent-history assembly / existing runtime behavior

## Mapping to OpenClaw Lifecycle

### 1. ingest

OpenClaw provides new transcript entries.
Adapter responsibility:
- normalize transcript entry shape
- call prototype `ingest()`
- persist semantic session snapshot into plugin-owned storage

Adapter output:
- no direct user-facing output
- best-effort background state update

### 2. assemble

OpenClaw asks the context engine to produce the input context for the next model call.
Adapter responsibility:
- recover or hydrate plugin state for the session
- call prototype `assemble()` with current turn text + token budget
- convert returned node-derived messages into OpenClaw-compatible context items
- emit a short `systemPromptAddition`

Fallback if assembly fails:
- return empty plugin augmentation
- let runtime continue with default / recent-history path

### 3. compact

OpenClaw triggers compaction when needed.
Adapter responsibility:
- call prototype `compact()` against the plugin snapshot
- persist generated summary node metadata into plugin storage
- optionally expose the resulting structured summary as compaction metadata for runtime inspection

Important:
- the adapter should not mutate canonical transcript history directly
- compaction summaries must retain transcript references for traceability

### 4. afterTurn

OpenClaw runs after the turn is complete.
Adapter responsibility:
- flush pending semantic state
- run low-priority index maintenance
- refresh retrieval caches
- optionally record metrics

## Proposed Adapter Surface

A practical adapter can expose an internal API like:

```ts
interface OpenClawContextEngineAdapter {
  ingest(params: { sessionId: string; entry: TranscriptEntryLike }): Promise<void>;
  assemble(params: {
    sessionId: string;
    currentTurnText?: string;
    tokenBudget: number;
  }): Promise<{
    messages: Array<Record<string, unknown>>;
    systemPromptAddition?: string;
    debug?: Record<string, unknown>;
  }>;
  compact(params: { sessionId: string }): Promise<{
    summaryNodeId?: string;
    notes?: string[];
  }>;
  afterTurn(params: { sessionId: string }): Promise<void>;
}
```

## Storage Plan

### Canonical source
- OpenClaw session transcript

### Plugin-owned index
Recommended plugin state:
- semantic nodes
- graph edges
- summary nodes
- task-state snapshots
- lightweight retrieval cache

Suggested implementation choices:
- start with a plugin-local SQLite store
- optionally add embeddings later

## Minimal First Integration

### Scope for first runtime integration
Only wire:
- `ingest`
- `assemble`

Why:
- they demonstrate value earliest
- lowest risk to runtime stability
- compaction integration can come after behavior is observed in real sessions

### First milestone success criteria
- plugin receives transcript events
- plugin assembles a task-state-guided context package
- plugin can inject `systemPromptAddition`
- failure falls back safely

## Second Integration Milestone

Add:
- `compact`
- `afterTurn`
- plugin diagnostics / metrics

## Runtime Risks to Watch

### 1. Over-extraction noise
Heuristic extraction may create too many semantic nodes.
Mitigation:
- cap extraction density
- score/rank nodes aggressively
- suppress low-value duplicates

### 2. Budget overrun
Assemble may overfill buckets.
Mitigation:
- strict per-bucket token accounting
- drop lower-ranked candidates first

### 3. Summary drift
Compaction summaries may drift away from transcript truth.
Mitigation:
- include transcript refs
- preserve canonical transcript untouched
- keep summary nodes traceable and replaceable

### 4. Runtime mismatch
Prototype message objects may not match OpenClaw runtime expectations.
Mitigation:
- centralize translation in adapter helpers

## Recommended Next Implementation Tasks

1. Add `src/openclaw-adapter.ts`
2. Add translation helpers:
   - transcript entry normalization
   - assembled node -> runtime message mapping
3. Add safe fallback path
4. Add adapter smoke test with toy transcript
5. Only after that, attempt runtime hookup in OpenClaw

## One-Sentence Summary

The plugin path is:

**OpenClaw transcript -> adapter -> hypergraph prototype -> task-state-guided assembly -> OpenClaw runtime**
