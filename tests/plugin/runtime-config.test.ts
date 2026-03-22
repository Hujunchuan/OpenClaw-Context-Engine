import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  CONTEXT_ENGINE_CONFIG_SCHEMA,
  CONTEXT_ENGINE_PLUGIN_INFO,
  normalizeContextEngineConfig,
} from '../../src/plugin/config.js';

test('plugin manifest stays aligned with shared plugin metadata and config schema', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../../openclaw.plugin.json', import.meta.url), 'utf8'),
  ) as {
    id: string;
    name: string;
    version: string;
    kind: string;
    description: string;
    configSchema: unknown;
  };

  assert.equal(manifest.id, CONTEXT_ENGINE_PLUGIN_INFO.id);
  assert.equal(manifest.name, CONTEXT_ENGINE_PLUGIN_INFO.name);
  assert.equal(manifest.version, CONTEXT_ENGINE_PLUGIN_INFO.version);
  assert.equal(manifest.kind, CONTEXT_ENGINE_PLUGIN_INFO.kind);
  assert.equal(manifest.description, CONTEXT_ENGINE_PLUGIN_INFO.description);
  assert.deepEqual(manifest.configSchema, CONTEXT_ENGINE_CONFIG_SCHEMA);
});

test('normalizeContextEngineConfig applies defaults from the shared config module', () => {
  const config = normalizeContextEngineConfig({
    pluginConfig: {
      disablePersistence: true,
      memoryWorkspaceRoot: './memory-root',
      flushOnCompact: false,
    },
  });

  assert.equal(config.disablePersistence, true);
  assert.equal(config.dbPath, undefined);
  assert.equal(config.flushOnCompact, false);
  assert.equal(config.enableLayeredRead, true);
  assert.equal(config.enableLayeredWrite, true);
  assert.ok(config.memoryWorkspaceRoot.endsWith('memory-root'));
});
