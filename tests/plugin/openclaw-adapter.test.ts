import test from 'node:test';
import assert from 'node:assert/strict';

import { toySessionId, toyTranscript } from '../../fixtures/toy-transcript.js';
import { OpenClawHypergraphAdapter } from '../../src/plugin/openclaw-adapter.js';

test('OpenClawHypergraphAdapter simulates runtime ingest + assemble', async () => {
  const adapter = new OpenClawHypergraphAdapter();

  await adapter.ingestMany({
    sessionId: toySessionId,
    entries: toyTranscript,
  });

  const assembled = await adapter.assemble({
    sessionId: toySessionId,
    currentTurnText: 'implement assemble and capture the sqlite next step',
    tokenBudget: 420,
  });

  assert.ok((assembled.messages?.length ?? 0) > 0);
  assert.match(assembled.systemPromptAddition ?? '', /HypergraphContextEngine assembled task-state-guided context/);
  assert.equal(assembled.messages[0]?.source, 'hypergraph-context-engine');
  assert.ok((assembled.debug?.bucketSummary?.length ?? 0) > 0);
  assert.ok(assembled.debug?.taskState?.intent);
});

test('OpenClawHypergraphAdapter compact returns a traceable summary node id', async () => {
  const adapter = new OpenClawHypergraphAdapter();

  await adapter.ingestMany({
    sessionId: toySessionId,
    entries: toyTranscript,
  });

  const compacted = await adapter.compact({ sessionId: toySessionId });

  assert.match(compacted.summaryNodeId ?? '', /summary/);
  assert.match(compacted.firstKeptEntryId ?? '', /u\d|a\d|t\d/i);
  assert.ok((compacted.tokensBefore ?? 0) > 0);
  if (compacted.tokensAfter != null) {
    assert.ok(compacted.tokensAfter > 0);
    assert.ok(compacted.tokensAfter < (compacted.tokensBefore ?? Number.MAX_SAFE_INTEGER));
  }
  assert.ok((compacted.notes?.length ?? 0) > 0);
});

test('OpenClawHypergraphAdapter assemble fails safe for unknown sessions', async () => {
  const adapter = new OpenClawHypergraphAdapter();

  const assembled = await adapter.assemble({
    sessionId: 'unknown-session',
    currentTurnText: 'hello',
    tokenBudget: 200,
  });

  assert.equal(Array.isArray(assembled.messages), true);
  assert.ok((assembled.messages?.length ?? 0) === 0);
  assert.match(assembled.systemPromptAddition ?? '', /no session snapshot yet|fallback/i);
});
