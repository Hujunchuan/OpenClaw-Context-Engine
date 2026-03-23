import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('package metadata declares OpenClaw extension entry and peer compatibility', () => {
  const packageJson = JSON.parse(
    readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
  ) as {
    openclaw?: {
      extensions?: string[];
    };
    peerDependencies?: Record<string, string>;
  };

  assert.deepEqual(packageJson.openclaw?.extensions, ['./index.ts']);
  assert.match(packageJson.peerDependencies?.openclaw ?? '', /^>=/);
});
