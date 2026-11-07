import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { atomicJson, readJson } from '../shared/state.mjs';
import { createLocalInstaller } from '../installation/local-installer.mjs';
import { STEPS } from '../installation/flow.mjs';

async function fixture(t, overrides = {}) {
  const home = await mkdtemp(join(tmpdir(), 'ferry-install-check-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, '.dashboard-token'), 'test-owner');
  const calls = [];
  const flow = createLocalInstaller(home, {
    run: async (command, args) => {
      calls.push({ command, args });
      assert.equal(command, 'botmux');
      assert.equal(args[1], 'install-verified');
      const guard = JSON.parse(args.at(-1));
      await atomicJson(join(home, 'plugins-registry.json'), { plugins: { [guard.id]: { packageName: guard.packageName, version: guard.version } } });
      return { stdout: '' };
    },
    runtime: async () => ({ ready: true, version: 'v24.16.0' }),
    setup: async () => ({ installed: true, version: 'test', authenticated: true }),
    ...overrides,
  });
  return { home, flow, calls };
}
test('installation checks only this environment, without a Bot or model selection', async t => {
  const { home, flow, calls } = await fixture(t);
  let item = await flow.begin('owner');
  assert.equal(Object.hasOwn(item, 'target'), false);
  assert.deepEqual(item.steps.map(step => step.id), ['environment', 'dependency', 'identity']);
  for (const _ of STEPS) item = await flow.advance(item.id, 'owner');
  assert.equal(item.state, 'ready');
  assert.equal(calls.length, 0);
  const installed = await flow.install(item.id, 'owner', true);
  assert.equal(installed.result.enabledAutomatically, false);
  assert.equal(calls.length, 1);
  await assert.rejects(access(join(home, 'bots.json')));
  assert.deepEqual(Object.keys((await readJson(join(home, 'plugins-registry.json'))).plugins), ['gateway-acceleration']);
});
test('runtime and internal login still block installation until ready', async t => {
  for (const overrides of [
    { runtime: async () => ({ ready: false }) },
    { setup: async () => ({ installed: true, authenticated: false }) },
  ]) {
    const { flow, calls } = await fixture(t, overrides);
    let item = await flow.begin('owner');
    for (const _ of STEPS) item = await flow.advance(item.id, 'owner');
    assert.equal(item.state, 'checking');
    assert.ok(item.steps.some(step => step.state === 'blocked'));
    await assert.rejects(flow.install(item.id, 'owner', true));
    assert.equal(calls.length, 0);
  }
});
