export function normalizeDialogueCueText(text: string | null | undefined): string {
  return stripDialogueScaffolding(text ?? '').toLowerCase();
}

export function looksLikeConversationRecall(text: string | null | undefined): boolean {
  const normalized = normalizeDialogueCueText(text);
  if (!normalized) {
    return false;
  }

  return /\b(previous|last|first|original)\s+message\b/.test(normalized)
    || /\bwhat did i say\b/.test(normalized)
    || /\bwhat were the\b/.test(normalized)
    || /\bwhat did you say\b/.test(normalized)
    || /\byour previous (message|reply|answer)\b/.test(normalized);
}

export function looksLikeTaskContinuationQuery(text: string | null | undefined): boolean {
  const normalized = normalizeDialogueCueText(text);
  if (!normalized) {
    return false;
  }

  if (/\bcontinue\b/.test(normalized) || /\bwhere were we\b/.test(normalized) || /\bwhat (?:are|were) we doing\b/.test(normalized)) {
    return true;
  }

  if (/\basked you to remember\b/.test(normalized) || /\bfrom today'?s memory\b/.test(normalized) || /\bthe context was that\b/.test(normalized)) {
    return true;
  }

  if (/\bwhat(?:'s| is)\b/.test(normalized) && /\b(current task|next step)\b/.test(normalized)) {
    return true;
  }

  if ((/\bcurrent task\b/.test(normalized) || /\bnext step\b/.test(normalized)) && (/\?$/.test(normalized) || /\banswer\b/.test(normalized))) {
    return true;
  }

  return false;
}

export function looksLikeRecallIntent(text: string | null | undefined): boolean {
  return looksLikeConversationRecall(text) || looksLikeTaskContinuationQuery(text);
}

export function looksLikeTaskSeedDeclaration(text: string | null | undefined): boolean {
  const normalized = normalizeDialogueCueText(text);
  if (!normalized || looksLikeTaskContinuationQuery(normalized)) {
    return false;
  }

  return isExplicitTaskDefinition(normalized) || isExplicitNextStep(normalized);
}

export type QueryGateMode =
  | 'default'
  | 'session_hot_only'
  | 'transcript_only';

export function looksLikeGreeting(text: string | null | undefined): boolean {
  const normalized = normalizeDialogueCueText(text);
  if (!normalized) {
    return false;
  }

  return /^(hi|hello|hey|yo|你好|您好|嗨|哈喽)\b/.test(normalized)
    || /^(good (morning|afternoon|evening))\b/.test(normalized);
}

export function looksLikeHeartbeat(text: string | null | undefined): boolean {
  const normalized = normalizeDialogueCueText(text);
  if (!normalized) {
    return false;
  }

  return /^(ping|test|still there|are you there|在吗|还在吗)\??$/.test(normalized);
}

export function looksLikeSimpleAck(text: string | null | undefined): boolean {
  const normalized = normalizeDialogueCueText(text);
  if (!normalized) {
    return false;
  }

  return /^(ok|okay|kk|got it|roger|thanks|thank you|thx|nice|cool|好的|收到|明白了|谢谢|行)\.?$/.test(normalized);
}

export function looksLikeLowInformationMetaQuery(text: string | null | undefined): boolean {
  const normalized = normalizeDialogueCueText(text);
  if (!normalized) {
    return false;
  }

  return /^(what can you do|who are you|what are you|are you working|are you alive)\??$/.test(normalized)
    || /^(你是谁|你能做什么|你还在工作吗)\??$/.test(normalized);
}

export function classifyQueryGateMode(text: string | null | undefined): QueryGateMode {
  if (
    looksLikeGreeting(text)
    || looksLikeHeartbeat(text)
    || looksLikeSimpleAck(text)
    || looksLikeLowInformationMetaQuery(text)
  ) {
    return 'transcript_only';
  }

  if (looksLikeTaskSeedDeclaration(text)) {
    return 'transcript_only';
  }

  if (looksLikeConversationRecall(text) || looksLikeTaskContinuationQuery(text)) {
    return 'session_hot_only';
  }

  return 'default';
}

export function looksLikeLowSignalStateNoise(text: string | null | undefined): boolean {
  const normalized = stripDialogueScaffolding(text ?? '').trim();
  if (!normalized) {
    return true;
  }

  if (/^\d{6,}$/.test(normalized)) {
    return true;
  }

  if (/^[0-9a-f]{8,}$/i.test(normalized)) {
    return true;
  }

  if (/^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(normalized)) {
    return true;
  }

  if (/^agent:[a-z0-9:_-]+$/i.test(normalized)) {
    return true;
  }

  const letterCount = (normalized.match(/\p{L}/gu) ?? []).length;
  const digitCount = (normalized.match(/\p{N}/gu) ?? []).length;
  const punctuationCount = (normalized.match(/[^\p{L}\p{N}\s]/gu) ?? []).length;

  if (letterCount === 0 && digitCount >= 4) {
    return true;
  }

  if (letterCount === 0 && punctuationCount >= 3 && normalized.length <= 24) {
    return true;
  }

  return false;
}

export function isExplicitTaskDefinition(text: string | null | undefined): boolean {
  const normalized = normalizeDialogueCueText(text);
  if (!normalized || looksLikeTaskContinuationQuery(normalized)) {
    return false;
  }

  return /(?:^|[.:]\s*)current task\s*(?:is|[:：-])\s*/.test(normalized)
    || /(?:^|[.:]\s*)当前任务\s*[:：-]\s*/.test(normalized);
}

export function isExplicitNextStep(text: string | null | undefined): boolean {
  const normalized = normalizeDialogueCueText(text);
  if (!normalized || looksLikeTaskContinuationQuery(normalized)) {
    return false;
  }

  return /(?:^|[.:]\s*)next step\s*(?:is|[:：-])\s*/.test(normalized)
    || /(?:^|[.:]\s*)下一步\s*[:：-]\s*/.test(normalized);
}

export function extractExplicitTaskDefinition(text: string | null | undefined): string | undefined {
  return extractCueValue(text, [
    /(?:^|[.:]\s*)current task\s*(?:is|[:：-])\s*/i,
    /(?:^|[.:]\s*)当前任务\s*[:：-]\s*/u,
  ]);
}

export function extractExplicitNextStep(text: string | null | undefined): string | undefined {
  return extractCueValue(text, [
    /(?:^|[.:]\s*)next step\s*(?:is|[:：-])\s*/i,
    /(?:^|[.:]\s*)下一步\s*[:：-]\s*/u,
  ]);
}

function extractCueValue(text: string | null | undefined, patterns: RegExp[]): string | undefined {
  const raw = stripDialogueScaffolding(text ?? '');
  if (!raw) {
    return undefined;
  }

  if (looksLikeTaskContinuationQuery(raw)) {
    return undefined;
  }

  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (!match) {
      continue;
    }

    const value = raw
      .slice((match.index ?? 0) + match[0].length)
      .replace(/^[\s:：-]+/, '')
      .replace(/[.。!?！？]+$/, '')
      .trim();
    if (value) {
      return value;
    }
  }

  return undefined;
}

function stripDialogueScaffolding(text: string): string {
  return text
    .trim()
    .replace(/^\[[^[\]]+\]\s*/u, '')
    .replace(/^(?:user|assistant|system)\s*[:：-]\s*/i, '')
    .trim();
}
