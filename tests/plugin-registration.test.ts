import test from 'node:test';
import assert from 'node:assert/strict';

import register from '../index.js';

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
