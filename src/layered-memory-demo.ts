import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { toySessionId, toyTranscript } from '../fixtures/toy-transcript.js';
import { HypergraphContextEngine } from './core/engine.js';

async function main() {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'openclaw-layered-memory-demo-'));
  const engine = new HypergraphContextEngine({
    memoryWorkspaceRoot: workspaceRoot,
    enableLayeredRead: true,
    enableLayeredWrite: true,
    flushOnAfterTurn: false,
    flushOnCompact: true,
  });

  await engine.ingestMany(toySessionId, toyTranscript);
  const flushResult = await engine.flushMemory(toySessionId, 'manual_save');
  const assembled = await engine.assemble({
    sessionId: toySessionId,
    currentTurnText: 'recover layered memory from markdown',
    tokenBudget: 400,
  });

  console.log(`Workspace root: ${workspaceRoot}`);
  console.log(`Written files: ${flushResult.writtenFiles.join(', ')}`);
  console.log(`Relevant memories: ${assembled.taskState?.relevantMemories.length ?? 0}`);
  console.log(`Top retrieval: ${assembled.retrievalSummary?.[0]?.nodeId ?? 'none'}`);
  console.log('\nNOW.md preview:\n');
  console.log(readFileSync(join(workspaceRoot, 'NOW.md'), 'utf8'));
}

void main();
