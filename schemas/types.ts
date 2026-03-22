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
  relevantMemories: string[];
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
