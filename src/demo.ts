import { runAllDemoScenarios } from '../fixtures/demo-scenarios.js';

function section(title: string): void {
  console.log(`\n${'='.repeat(16)} ${title} ${'='.repeat(16)}`);
}

function printList(items: string[], indent = '  - '): void {
  if (items.length === 0) {
    console.log(`${indent}(none)`);
    return;
  }

  for (const item of items) {
    console.log(`${indent}${item}`);
  }
}

const snapshots = await runAllDemoScenarios();

for (const snapshot of snapshots) {
  section(`SCENARIO ${snapshot.sessionId}`);

  section('Assembled TaskState');
  console.log(`Intent: ${snapshot.assembled.taskState.intent ?? '(unknown)'}`);
  console.log('Constraints:');
  printList(snapshot.assembled.taskState.constraints);
  console.log('Active decisions:');
  printList(snapshot.assembled.taskState.activeDecisions);
  console.log('Priority backlog:');
  printList(snapshot.assembled.taskState.priorityBacklog);
  console.log('Priority status:');
  if (snapshot.assembled.taskState.priorityStatus.length === 0) {
    console.log('  - (none)');
  } else {
    for (const item of snapshot.assembled.taskState.priorityStatus) {
      console.log(`  - ${item.item} [${item.status}]`);
    }
  }
  console.log('Open loops:');
  printList(snapshot.assembled.taskState.openLoops);
  console.log('Resolved open loops:');
  printList(snapshot.assembled.taskState.resolvedOpenLoops);
  console.log('Artifact state:');
  printList(snapshot.assembled.taskState.artifactState);

  section('Assemble Buckets');
  for (const bucket of snapshot.assembled.bucketSummary) {
    console.log(`- ${bucket.name}: count=${bucket.count}, budgetTokens=${bucket.budgetTokens}`);
  }

  section('Retrieval Summary (top candidates)');
  for (const candidate of snapshot.assembled.retrievalSummary) {
    console.log(
      `- ${candidate.nodeId} kind=${candidate.kind ?? 'unknown'} bucket=${candidate.bucket ?? 'unknown'} selected=${candidate.selected} score=${candidate.finalScore.toFixed(3)}`,
    );
  }

  section('Compaction Summary Node');
  console.log(`Intent: ${snapshot.compact.summary.intent ?? '(unknown)'}`);
  console.log('Final decisions:');
  printList(snapshot.compact.summary.finalDecisions);
  console.log('Candidate decisions:');
  printList(snapshot.compact.summary.candidateDecisions);
  console.log('Tool facts:');
  printList(snapshot.compact.summary.toolFacts);
  console.log('Artifact final state:');
  printList(snapshot.compact.summary.artifactFinalState);
  console.log('Open loops remaining:');
  printList(snapshot.compact.summary.openLoopsRemaining);
  console.log('Resolved open loops:');
  printList(snapshot.compact.summary.resolvedOpenLoops);
  console.log(`Confidence: ${snapshot.compact.summary.confidence ?? 0}`);

  section('After Compact Re-assemble');
  console.log(`Message kinds: ${snapshot.reassembledAfterCompact.messageKinds.join(', ')}`);
  for (const bucket of snapshot.reassembledAfterCompact.bucketSummary) {
    console.log(`- ${bucket.name}: count=${bucket.count}, budgetTokens=${bucket.budgetTokens}`);
  }

  section('Edge Kinds');
  for (const [kind, count] of Object.entries(snapshot.edgeKinds)) {
    console.log(`- ${kind}: ${count}`);
  }
}
