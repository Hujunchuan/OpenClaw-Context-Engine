import { toySessionId, toyTranscript } from '../fixtures/toy-transcript.js';
import { OpenClawHypergraphAdapter } from './plugin/openclaw-adapter.js';

function section(title: string): void {
  console.log(`\n${'='.repeat(16)} ${title} ${'='.repeat(16)}`);
}

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

const compacted = await adapter.compact({ sessionId: toySessionId });
await adapter.afterTurn({
  sessionId: toySessionId,
  taskState: assembled.debug?.taskState,
});

section('Simulated OpenClaw Runtime Input');
console.log(
  JSON.stringify(
    {
      sessionId: toySessionId,
      currentTurnText: 'implement assemble and capture the sqlite next step',
      tokenBudget: 420,
      transcriptEntries: toyTranscript.length,
    },
    null,
    2,
  ),
);

section('Adapter Assemble Result');
console.log(`systemPromptAddition: ${assembled.systemPromptAddition ?? '(none)'}`);
console.log(`messages returned: ${assembled.messages.length}`);
console.log('bucketSummary:');
for (const bucket of assembled.debug?.bucketSummary ?? []) {
  console.log(`- ${bucket.name}: count=${bucket.count}, budgetTokens=${bucket.budgetTokens}`);
}

section('Sample Runtime Messages');
for (const message of assembled.messages.slice(0, 6)) {
  console.log(
    JSON.stringify(
      {
        id: message.id,
        kind: message.kind,
        source: message.source,
        createdAt: message.createdAt,
      },
      null,
      2,
    ),
  );
}

section('Compact Result');
console.log(JSON.stringify(compacted, null, 2));

section('Adapter Debug TaskState');
console.log(JSON.stringify(assembled.debug?.taskState ?? {}, null, 2));
