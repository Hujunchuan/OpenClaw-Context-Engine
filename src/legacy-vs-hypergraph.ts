import { toySessionId, toyTranscript } from '../fixtures/toy-transcript.js';
import { compactSession } from './core/compact.js';
import { HypergraphContextEngine } from './core/engine.js';

function section(title: string): void {
  console.log(`\n${'='.repeat(16)} ${title} ${'='.repeat(16)}`);
}

function buildLegacyView() {
  const recentMessages = toyTranscript.slice(-3).map((entry) => ({
    id: entry.id,
    role: entry.role,
    text: typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content),
  }));

  const summary = [
    'User asked for the Hypergraph Context Engine MVP.',
    'Assistant agreed to implement task-state, ingest, then assemble.',
    'A tool result confirmed transcript tree should remain source of truth.',
    'Assistant reported task-state and ingest were added and assemble + toy demo remain next.',
    'User requested a clear SQLite follow-up for later.',
  ].join(' ');

  return {
    recentMessages,
    summary,
  };
}

const engine = new HypergraphContextEngine();
await engine.ingestMany(toySessionId, toyTranscript);
const assembled = await engine.assemble({
  sessionId: toySessionId,
  currentTurnText: 'implement assemble and capture the sqlite next step',
  tokenBudget: 500,
});
const snapshot = engine.debugSession(toySessionId);
const compacted = snapshot ? compactSession(snapshot) : undefined;
const legacy = buildLegacyView();

section('Legacy View');
console.log('Recent dialogue:');
for (const message of legacy.recentMessages) {
  console.log(`- ${message.id} [${message.role ?? 'unknown'}] ${message.text}`);
}
console.log(`\nLinear summary:\n${legacy.summary}`);

section('Hypergraph View');
console.log(`Intent: ${assembled.taskState?.intent ?? '(unknown)'}`);
console.log('Constraints:');
for (const item of assembled.taskState?.constraints ?? []) {
  console.log(`- ${item}`);
}
console.log('Active decisions:');
for (const item of assembled.taskState?.activeDecisions ?? []) {
  console.log(`- ${item}`);
}
console.log('Open loops:');
for (const item of assembled.taskState?.openLoops ?? []) {
  console.log(`- ${item}`);
}
console.log('Resolved open loops:');
for (const item of assembled.taskState?.resolvedOpenLoops ?? []) {
  console.log(`- ${item}`);
}
console.log('\nBucket summary:');
for (const bucket of assembled.bucketSummary ?? []) {
  console.log(`- ${bucket.name}: count=${bucket.count}, budgetTokens=${bucket.budgetTokens}`);
}
console.log('\nTop retrieval summary:');
for (const candidate of assembled.retrievalSummary ?? []) {
  console.log(`- ${candidate.nodeId} kind=${candidate.kind ?? 'unknown'} selected=${candidate.selected} score=${candidate.finalScore.toFixed(3)}`);
}
if (compacted) {
  console.log('\nStructured summary node payload:');
  console.log(JSON.stringify(compacted.summaryNode.payload, null, 2));
}

section('Difference');
console.log([
  'Legacy keeps the newest dialogue and one flat narrative summary.',
  'Hypergraph recovery reconstructs task state explicitly: intent, constraints, decisions, open loops, and artifact/tool evidence.',
  'That means the engine can assemble context around the current task instead of replaying a long linear history.',
].join(' '));
