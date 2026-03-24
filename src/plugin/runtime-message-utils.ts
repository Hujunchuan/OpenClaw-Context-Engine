import {
  extractExplicitNextStep,
  isExplicitTaskDefinition,
  looksLikeConversationRecall,
  looksLikeTaskContinuationQuery,
} from '../core/dialogue-cues.js';

const CONTEXT_ENGINE_SOURCE = 'hypergraph-context-engine';

export type SlotSafeAnchor =
  | 'first_user_message'
  | 'previous_user_message'
  | 'previous_assistant_message'
  | 'latest_task_definition'
  | 'latest_user_next_step'
  | 'latest_assistant_commitment';

export interface SlotSafeRecallRule {
  name: string;
  patterns: RegExp[];
  anchors: SlotSafeAnchor[];
}

export interface SlotSafeAssemblePolicy {
  recentTurnsToKeep: number;
  maxRecentMessages: number;
  allowedRuntimeRoles: string[];
  allowedRuntimeTypes: string[];
  recallRules: SlotSafeRecallRule[];
  systemPromptOnlyContent: string[];
}

export type SlotSafeRuntimeProfileName = 'plain-dialogue' | 'tool-turns' | 'structured-assistant';

export interface SlotSafeRuntimeProfile extends SlotSafeAssemblePolicy {
  name: SlotSafeRuntimeProfileName;
  preserveWholeSelectedTurns: boolean;
}

const SLOT_SAFE_BASE_POLICY: SlotSafeAssemblePolicy = {
  recentTurnsToKeep: 3,
  maxRecentMessages: 8,
  allowedRuntimeRoles: ['user', 'assistant', 'system', 'tool'],
  allowedRuntimeTypes: ['message', 'tool_result', 'tool_call', 'tool'],
  recallRules: [
    {
      name: 'previous-user-message',
      patterns: [/\b(previous|last)\s+message\b/i, /\bwhat did i say\b/i],
      anchors: ['previous_user_message'],
    },
    {
      name: 'first-user-message',
      patterns: [/\b(first|original)\s+message\b/i, /\bbeginning\b/i],
      anchors: ['first_user_message'],
    },
    {
      name: 'previous-assistant-message',
      patterns: [/\bwhat did you say\b/i, /\byour previous (message|reply|answer)\b/i],
      anchors: ['previous_assistant_message'],
    },
    {
      name: 'task-continuation',
      patterns: [
        /\bwhat(?:'s| is)\b.*\b(current task|next step)\b/i,
        /\bcontinue\b/i,
        /\bwhere were we\b/i,
        /\bwhat are we doing\b/i,
        /\bwhat were we doing\b/i,
      ],
      anchors: ['latest_task_definition', 'latest_user_next_step', 'latest_assistant_commitment'],
    },
  ],
  systemPromptOnlyContent: [
    'task_state_summary',
    'active_decisions',
    'constraints',
    'open_loops',
    'memory_recall_summary',
    'hypergraph_evidence_summary',
    'layer_metadata',
    'route_reasoning',
  ],
};

export const SLOT_SAFE_RUNTIME_PROFILES: Record<SlotSafeRuntimeProfileName, SlotSafeRuntimeProfile> = {
  'plain-dialogue': {
    name: 'plain-dialogue',
    ...SLOT_SAFE_BASE_POLICY,
    recentTurnsToKeep: 3,
    maxRecentMessages: 8,
    preserveWholeSelectedTurns: false,
  },
  'tool-turns': {
    name: 'tool-turns',
    ...SLOT_SAFE_BASE_POLICY,
    recentTurnsToKeep: 3,
    maxRecentMessages: 10,
    preserveWholeSelectedTurns: true,
  },
  'structured-assistant': {
    name: 'structured-assistant',
    ...SLOT_SAFE_BASE_POLICY,
    recentTurnsToKeep: 2,
    maxRecentMessages: 10,
    preserveWholeSelectedTurns: true,
  },
};

export const SLOT_SAFE_ASSEMBLE_POLICY = SLOT_SAFE_RUNTIME_PROFILES['plain-dialogue'];

const SAFE_RUNTIME_ROLES = new Set(SLOT_SAFE_BASE_POLICY.allowedRuntimeRoles);
const SAFE_RUNTIME_TYPES = new Set(SLOT_SAFE_BASE_POLICY.allowedRuntimeTypes);

export function getContextEngineSource(): string {
  return CONTEXT_ENGINE_SOURCE;
}

export function shouldSyncRuntimeMessage(message: Record<string, unknown>): boolean {
  return message.source !== CONTEXT_ENGINE_SOURCE;
}

export function extractLatestUserTextFromRuntimeMessages(messages: Array<Record<string, unknown>>): string | undefined {
  const reversed = [...messages].reverse();
  for (const message of reversed) {
    const role = readMessageRole(message);
    if (role !== 'user') {
      continue;
    }

    const text = normalizeRuntimeContentToText(message.content);
    if (text) {
      return text;
    }
  }

  return undefined;
}

export function normalizeRuntimeContentToText(content: unknown): string {
  if (typeof content === 'string') {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map(normalizeRuntimeContentToText)
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  if (!content || typeof content !== 'object') {
    return '';
  }

  const record = content as Record<string, unknown>;
  const textCandidates = [
    record.text,
    record.value,
    record.summary,
    record.message,
    record.output_text,
    record.input_text,
    record.outputText,
    record.inputText,
    record.title,
  ]
    .map(readString)
    .filter((value): value is string => Boolean(value?.trim()));

  if (textCandidates.length > 0) {
    return textCandidates.join('\n').trim();
  }

  if ('content' in record) {
    return normalizeRuntimeContentToText(record.content);
  }

  return '';
}

export function toRuntimeContextMessage(message: Record<string, unknown>): Record<string, unknown> | undefined {
  if (looksLikeRuntimeMessage(message)) {
    const contentText = normalizeRuntimeContentToText(message.content);
    if (!contentText) {
      return undefined;
    }

    return {
      ...message,
      content: contentText,
      source: CONTEXT_ENGINE_SOURCE,
    };
  }

  const kind = readString(message.kind);
  const id = readString(message.id);
  const createdAt = readString(message.createdAt);
  const payload = asRecord(message.content);

  if (kind === 'message') {
    const role = readString(payload?.role) ?? 'assistant';
    const text = normalizeRuntimeContentToText(payload?.text ?? payload);
    if (!text) {
      return undefined;
    }

    return {
      id,
      role,
      content: text,
      createdAt,
      source: CONTEXT_ENGINE_SOURCE,
    };
  }

  if (kind === 'tool_result') {
    const text = normalizeRuntimeContentToText(payload?.result ?? payload?.text ?? payload);
    if (!text) {
      return undefined;
    }

    return {
      id,
      role: 'assistant',
      content: text,
      createdAt,
      source: CONTEXT_ENGINE_SOURCE,
      type: 'tool_result',
      toolName: readString(payload?.toolName),
    };
  }

  return undefined;
}

export function selectSafeRuntimeMessages(
  messages: Array<Record<string, unknown>>,
  currentTurnText?: string,
): Array<Record<string, unknown>> {
  const profile = detectSlotSafeRuntimeProfile(messages);
  const canonicalMessages = messages
    .filter(shouldSyncRuntimeMessage)
    .filter(isCanonicalRuntimeMessage);

  if (canonicalMessages.length <= profile.maxRecentMessages) {
    return canonicalMessages;
  }

  const selectedIds = new Set<string>();
  const turns = groupMessagesIntoTurns(canonicalMessages);
  const recentWindow = selectRecentTurnWindow(canonicalMessages, turns, profile);
  for (const message of recentWindow) {
    selectedIds.add(String(message.id));
  }

  for (const message of resolveAnchoredMessages(canonicalMessages, currentTurnText)) {
    selectedIds.add(String(message.id));
  }

  expandSelectionForProfile(selectedIds, turns, profile);

  const taskContinuationQuery = looksLikeTaskContinuationQuery(currentTurnText);
  const hasUserDefinedNextStep = Boolean(findLatestUserNextStep(canonicalMessages));

  return canonicalMessages
    .filter((message) => selectedIds.has(String(message.id)))
    .filter((message) => !shouldSuppressAssistantCommitment(message, taskContinuationQuery, hasUserDefinedNextStep));
}

export function detectSlotSafeRuntimeProfile(
  messages: Array<Record<string, unknown>>,
): SlotSafeRuntimeProfile {
  const canonicalMessages = messages
    .filter(shouldSyncRuntimeMessage)
    .filter((message) => Boolean(readMessageRole(message)));

  if (canonicalMessages.some(looksLikeStructuredAssistantMessage)) {
    return SLOT_SAFE_RUNTIME_PROFILES['structured-assistant'];
  }

  if (canonicalMessages.some(isToolLikeRuntimeMessage)) {
    return SLOT_SAFE_RUNTIME_PROFILES['tool-turns'];
  }

  return SLOT_SAFE_RUNTIME_PROFILES['plain-dialogue'];
}

function looksLikeRuntimeMessage(message: Record<string, unknown>): boolean {
  return typeof message.role === 'string' && 'content' in message;
}

function isCanonicalRuntimeMessage(message: Record<string, unknown>): boolean {
  if (message.source === CONTEXT_ENGINE_SOURCE) {
    return false;
  }

  const role = readMessageRole(message);
  const type = readString(message.type)?.toLowerCase();
  if (!role || !SAFE_RUNTIME_ROLES.has(role)) {
    return false;
  }

  if (type && !SAFE_RUNTIME_TYPES.has(type)) {
    return false;
  }

  return hasRuntimePayload(message);
}

function findPreviousUserMessage(messages: Array<Record<string, unknown>>): Record<string, unknown> | undefined {
  const userMessages = messages.filter((message) => readMessageRole(message) === 'user');
  return userMessages.at(-2);
}

function resolveAnchoredMessages(
  messages: Array<Record<string, unknown>>,
  currentTurnText?: string,
): Array<Record<string, unknown>> {
  const text = currentTurnText ?? '';
  if (!text.trim()) {
    return [];
  }

  const anchors = new Set<SlotSafeAnchor>();
  for (const rule of SLOT_SAFE_ASSEMBLE_POLICY.recallRules) {
    if (rule.patterns.some((pattern) => pattern.test(text))) {
      for (const anchor of rule.anchors) {
        anchors.add(anchor);
      }
    }
  }

  return [...anchors]
    .map((anchor) => resolveAnchorMessage(messages, anchor))
    .filter((message): message is Record<string, unknown> => Boolean(message));
}

function resolveAnchorMessage(
  messages: Array<Record<string, unknown>>,
  anchor: SlotSafeAnchor,
): Record<string, unknown> | undefined {
  switch (anchor) {
    case 'first_user_message':
      return messages.find((message) => readMessageRole(message) === 'user');
    case 'previous_user_message':
      return findPreviousUserMessage(messages);
    case 'previous_assistant_message':
      return findPreviousAssistantMessage(messages);
    case 'latest_task_definition':
      return findLatestTaskDefinition(messages);
    case 'latest_user_next_step':
      return findLatestUserNextStep(messages);
    case 'latest_assistant_commitment':
      return findLatestAssistantCommitment(messages);
    default:
      return undefined;
  }
}

function selectRecentTurnWindow(
  messages: Array<Record<string, unknown>>,
  turns: Array<Array<Record<string, unknown>>>,
  profile: SlotSafeRuntimeProfile,
): Array<Record<string, unknown>> {
  const selectedIds = new Set<string>();

  for (const turn of turns.slice(-profile.recentTurnsToKeep)) {
    for (const message of turn) {
      selectedIds.add(String(message.id));
    }
  }

  const recentMessages = messages.slice(-profile.maxRecentMessages);
  for (const message of recentMessages) {
    selectedIds.add(String(message.id));
  }

  return messages.filter((message) => selectedIds.has(String(message.id)));
}

function expandSelectionForProfile(
  selectedIds: Set<string>,
  turns: Array<Array<Record<string, unknown>>>,
  profile: SlotSafeRuntimeProfile,
): void {
  if (!profile.preserveWholeSelectedTurns) {
    return;
  }

  for (const turn of turns) {
    if (!turn.some((message) => selectedIds.has(String(message.id)))) {
      continue;
    }

    for (const message of turn) {
      selectedIds.add(String(message.id));
    }
  }
}

function groupMessagesIntoTurns(messages: Array<Record<string, unknown>>): Array<Array<Record<string, unknown>>> {
  const turns: Array<Array<Record<string, unknown>>> = [];
  let currentTurn: Array<Record<string, unknown>> = [];

  for (const message of messages) {
    if (readMessageRole(message) === 'user' && currentTurn.length > 0) {
      turns.push(currentTurn);
      currentTurn = [message];
      continue;
    }

    currentTurn.push(message);
  }

  if (currentTurn.length > 0) {
    turns.push(currentTurn);
  }

  return turns;
}

function findPreviousAssistantMessage(messages: Array<Record<string, unknown>>): Record<string, unknown> | undefined {
  const assistantMessages = messages.filter((message) => readMessageRole(message) === 'assistant');
  return assistantMessages.at(-2);
}

function findLatestTaskDefinition(messages: Array<Record<string, unknown>>): Record<string, unknown> | undefined {
  const userMessages = messages
    .filter((message) => readMessageRole(message) === 'user')
    .filter((message) => {
      const text = normalizeRuntimeContentToText(message.content);
      return Boolean(text) && (isExplicitTaskDefinition(text) || !looksLikeRecallOrContinuationPrompt(text));
    });

  return userMessages.at(-1);
}

function findLatestUserNextStep(messages: Array<Record<string, unknown>>): Record<string, unknown> | undefined {
  const userMessages = messages
    .filter((message) => readMessageRole(message) === 'user')
    .filter((message) => Boolean(extractExplicitNextStep(normalizeRuntimeContentToText(message.content))));

  return userMessages.at(-1);
}

function findLatestAssistantCommitment(messages: Array<Record<string, unknown>>): Record<string, unknown> | undefined {
  const assistantMessages = messages
    .filter((message) => readMessageRole(message) === 'assistant')
    .filter((message) => looksLikeAssistantCommitment(normalizeRuntimeContentToText(message.content)));

  return assistantMessages.at(-1);
}

function looksLikeRecallOrContinuationPrompt(text: string): boolean {
  return looksLikeConversationRecall(text) || looksLikeTaskContinuationQuery(text);
}

function looksLikeAssistantCommitment(text: string): boolean {
  if (!text.trim()) {
    return false;
  }

  return /\b(next step|i('| wi)ll|ready|updated|stored|confirm|continue)\b/i.test(text);
}

function shouldSuppressAssistantCommitment(
  message: Record<string, unknown>,
  taskContinuationQuery: boolean,
  hasUserDefinedNextStep: boolean,
): boolean {
  if (!taskContinuationQuery || !hasUserDefinedNextStep) {
    return false;
  }

  return readMessageRole(message) === 'assistant'
    && looksLikeAssistantCommitment(normalizeRuntimeContentToText(message.content));
}

function hasRuntimePayload(message: Record<string, unknown>): boolean {
  return normalizeRuntimeContentToText(message.content).length > 0
    || looksLikeStructuredAssistantMessage(message)
    || isToolLikeRuntimeMessage(message);
}

function isToolLikeRuntimeMessage(message: Record<string, unknown>): boolean {
  const role = readMessageRole(message);
  const type = readString(message.type)?.toLowerCase();
  return role === 'tool'
    || type === 'tool_call'
    || type === 'tool_result'
    || Boolean(message.toolCallId || message.toolUseId || message.toolName);
}

function looksLikeStructuredAssistantMessage(message: Record<string, unknown>): boolean {
  const role = readMessageRole(message);
  if (role !== 'assistant') {
    return false;
  }

  const content = message.content;
  return Array.isArray(content) || (Boolean(content) && typeof content === 'object' && !('text' in (content as Record<string, unknown>)));
}

function readMessageRole(message: Record<string, unknown>): string | undefined {
  const role = readString(message.role)?.toLowerCase();
  if (role) {
    return role;
  }

  const type = readString(message.type)?.toLowerCase();
  if (type === 'tool_call' || type === 'tool_result' || type === 'tool') {
    return 'tool';
  }

  return type;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
