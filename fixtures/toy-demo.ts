import { runAllDemoScenarios } from './demo-scenarios.js';

const snapshots = await runAllDemoScenarios();

for (const snapshot of snapshots) {
  console.log(`=== SCENARIO: ${snapshot.sessionId} ===`);
  console.log(JSON.stringify(snapshot, null, 2));
}
