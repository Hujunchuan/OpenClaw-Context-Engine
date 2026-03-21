import type { TranscriptEntryLike } from '../src/engine.js';
import { HypergraphContextEngine } from '../src/engine.js';
import { SQLiteStore } from '../src/sqlite-store.js';
import { branchingSessionId, branchingTranscript } from './branching-transcript.js';
import { toySessionId, toyTranscript } from './toy-transcript.js';

await runScenario(toySessionId, toyTranscript, 'implement assemble and capture the sqlite next step');
await runScenario(
  branchingSessionId,
  branchingTranscript,
  'update the toy transcript demo and keep the golden fixture follow-up visible',
);

async function runScenario(sessionId: string, transcript: TranscriptEntryLike[], currentTurnText: string) {
  const store = new SQLiteStore(':memory:');
  const engine = new HypergraphContextEngine({ store });

  const assembled = await engine.ingestAndAssemble(sessionId, transcript, {
    currentTurnText,
    tokenBudget: 500,
  });

  const compacted = await engine.compact(sessionId);
  const debugSession = engine.debugSession(sessionId);
  const summaryNode = debugSession?.nodes.find((node) => node.id === compacted.summaryNodeId);

  console.log(`=== SCENARIO: ${sessionId} ===`);
  console.log('--- ASSEMBLED CONTEXT ---');
  console.log(JSON.stringify(assembled, null, 2));
  console.log('--- EDGES ---');
  console.log(JSON.stringify(debugSession?.edges, null, 2));
  console.log('--- COMPACTION ---');
  console.log(JSON.stringify(compacted, null, 2));
  console.log('--- SUMMARY NODE ---');
  console.log(JSON.stringify(summaryNode, null, 2));
  console.log('--- STORED SESSION IDS ---');
  console.log(JSON.stringify(store.listSessionIds(), null, 2));

  store.close();
}
