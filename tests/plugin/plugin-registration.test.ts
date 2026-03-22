import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { toyTranscript } from '../../fixtures/toy-transcript.js';
import register from '../../index.js';

test('plugin registers a context engine under the manifest id', async () => {
  const registrations: Array<{ id: string; factory: () => unknown | Promise<unknown> }> = [];

  register({
    registerContextEngine(id, factory) {
      registrations.push({ id, factory });
    },
  });

  assert.equal(registrations.length, 1);
  assert.equal(registrations[0]?.id, 'hypergraph-context-engine');

  const engine = await registrations[0]!.factory() as {
    info: { id: string; name: string };
    ingest: Function;
    assemble: Function;
    compact: Function;
    afterTurn: Function;
  };

  assert.equal(engine.info.id, 'hypergraph-context-engine');
  assert.equal(typeof engine.ingest, 'function');
  assert.equal(typeof engine.assemble, 'function');
  assert.equal(typeof engine.compact, 'function');
  assert.equal(typeof engine.afterTurn, 'function');
});

test('plugin reuses persisted session state across fresh runtime engine instances', async () => {
  const registrations: Array<{ id: string; factory: (runtimeConfig?: unknown) => unknown | Promise<unknown> }> = [];
  const tempDir = mkdtempSync(join(tmpdir(), 'openclaw-context-engine-test-'));
  const dbPath = join(tempDir, 'hypergraph-context-engine.sqlite');

  register({
    registerContextEngine(id, factory) {
      registrations.push({ id, factory });
    },
  });

  const firstEngine = await registrations[0]!.factory({ dbPath }) as {
    ingestBatch: Function;
    assemble: Function;
  };
  await firstEngine.ingestBatch({
    sessionId: 'turn-1',
    sessionKey: 'chat-123',
    messages: toyTranscript.map((entry) => ({
      ...entry,
      role: entry.role ?? entry.type,
    })),
  });

  const secondEngine = await registrations[0]!.factory({ dbPath }) as {
    assemble: Function;
  };
  const assembled = await secondEngine.assemble({
    sessionId: 'turn-2',
    sessionKey: 'chat-123',
    messages: [
      ...toyTranscript.map((entry) => ({
        ...entry,
        role: entry.role ?? entry.type,
      })),
      {
        id: 'turn-2-user',
        role: 'user',
        content: '继续做 sqlite 这块，别忘了前面做到哪了',
        createdAt: new Date().toISOString(),
      },
    ],
    tokenBudget: 400,
  });

  assert.ok((assembled.messages?.length ?? 0) > 0);
  assert.match(assembled.systemPromptAddition ?? '', /Intent:/);
});
