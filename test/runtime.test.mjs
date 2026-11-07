import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectRuntime, installRuntime } from '../gateway/src/lib/runtime.mjs';

test('runtime discovery reuses Node with bundled npm without changing PATH', async () => {
  const before = process.env.PATH;
  const value = await detectRuntime('/fixture', {
    access: async () => {},
    run: async (_command, args) => ({ stdout: args[0] === '-p' ? '/fixture/bin/node' : args.length === 1 ? 'v24.16.0' : '10.0.0' }),
  });
  assert.equal(value.node, '/fixture/bin/node');
  assert.match(value.npm, /npm-cli\.js$/);
  assert.equal(process.env.PATH, before);
});
test('runtime repair requires a click and rejects a modified official archive', async t => {
  const home = await mkdtemp(join(tmpdir(), 'ferry-runtime-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  let downloads = 0, extracts = 0;
  const deps = {
    platform: 'darwin', arch: 'arm64',
    run: async command => { if (command === 'tar') extracts++; throw new Error('missing runtime'); },
    fetcher: async url => {
      downloads++;
      assert.ok(url.startsWith('https://nodejs.org/dist/v24.16.0/'));
      return new Response(url.endsWith('SHASUMS256.txt') ? `${'a'.repeat(64)}  node-v24.16.0-darwin-arm64.tar.gz\n` : 'modified archive');
    },
  };
  await assert.rejects(installRuntime({ confirm: false }, home, deps), /确认/);
  assert.equal(downloads, 0);
  await assert.rejects(installRuntime({ confirm: true }, home, deps), /完整性/);
  assert.equal(downloads, 2);
  assert.equal(extracts, 0);
});
