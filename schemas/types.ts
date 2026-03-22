export type NodeKind =
  | 'message'
  | 'tool_call'
  | 'tool_result'
  | 'decision'
  | 'constraint'
  | 'intent'
  | 'artifact_snapshot'
  | 'memory_chunk'
  | 'open_loop'
  | 'summary';

export type EdgeKind =
  | 'responds_to'
  | 'depends_on'
  | 'derived_from'
  | 'supersedes'
  | 'resolves'
  | 'invalidates';

export type HyperedgeKind =
  | 'supports'
  | 'constitutes'
  | 'updates'
  | 'resolves'
  | 'invalidates';

export type MemoryLayer =
  | 'hot'
  | 'warm'
  | 'cold'
  | 'daily_log'
  | 'memory_core'
  | 'archive';

export type MemoryScope =
  | 'task'
  | 'project'
  | 'workflow'
  | 'user'
  | 'system';

export type FlushReason =
  | 'turn_end'
  | 'tool_complete'
  | 'stage_complete'
  | 'compaction'
  | 'manual_save'
  | 'manual_reset'
  | 'manual_new';

export interface RelevantMemoryRef {
  nodeId: string;
  layer: MemoryLayer;
  sourceFile: string;
  summary: string;
  score: number;
  title?: string;
  routeReason?: string;
}

export interface MemoryChunkPayload extends Record<string, unknown> {
  layer: MemoryLayer;
  scope: MemoryScope;
  sourceFile: string;
  title: string;
  summary: string;
  text?: string;
  category?: string;
  routeReason?: string;
  dedupeKey: string;
  persistence: 'turn' | 'task' | 'project' | 'long_term';
  recurrence: number;
  connectivity: number;
  activationEnergy: 'low' | 'medium' | 'high';
  status: 'active' | 'archived' | 'invalidated';
  updatedAt: string;
  firstSeenAt?: string;
  hitCount?: number;
  sessionCount?: number;
  lastSessionId?: string;
}

export interface BaseNode {
  id: string;
  kind: NodeKind;
  sessionId: string;
  transcriptId?: string;
  parentTranscriptId?: string;
  createdAt: string;
  score?: number;
  tags?: string[];
  payload: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  kind: EdgeKind;
  from: string;
  to: string;
  createdAt: string;
  weight?: number;
  reason?: string;
}

export interface Hyperedge {
  id: string;
  kind: HyperedgeKind;
  members: string[];
  target?: string;
  createdAt: string;
  weight?: number;
  confidence?: number;
  reason?: string;
}

export interface PriorityStatusItem {
  item: string;
  status: 'pending' | 'active' | 'open_loop' | 'resolved';
  source: 'priority_list' | 'summary';
}

export interface TaskState {
  sessionId: string;
  intent: string | null;
  constraints: string[];
  activeDecisions: string[];
  candidateDecisions: string[];
  toolFacts: string[];
  artifactState: string[];
  priorityBacklog: string[];
  priorityStatus: PriorityStatusItem[];
  openLoops: string[];
  resolvedOpenLoops: string[];
  relevantMemories: RelevantMemoryRef[];
  confidence: number;
  lastUpdatedAt: string;
}

export interface SummaryNodePayload {
  summaryId: string;
  branchRoot: string;
  intent: string | null;
  constraints: string[];
  finalDecisions: string[];
  candidateDecisions: string[];
  toolFacts: string[];
  evidenceRefs: string[];
  artifactFinalState: string[];
  priorityBacklog: string[];
  priorityStatus?: PriorityStatusItem[];
  openLoopsRemaining: string[];
  resolvedOpenLoops: string[];
  relevantMemories?: RelevantMemoryRef[];
  validUntil?: string;
  confidence: number;
}

export interface RetrievalCandidate {
  nodeId: string;
  graphScore: number;
  retrievalScore: number;
  recencyScore: number;
  utilityScore: number;
  redundancyPenalty: number;
  finalScore: number;
}

export interface AssembleBucket {
  name:
    | 'recent_dialogue'
    | 'task_state'
    | 'evidence'
    | 'artifact'
    | 'memory_patch';
  budgetTokens: number;
  nodeIds: string[];
}
