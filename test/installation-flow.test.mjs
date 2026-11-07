import test from 'node:test';
import assert from 'node:assert/strict';
import { createInstallationFlow, STEPS } from '../installation/flow.mjs';
function fixture(overrides = {}) {
  const calls = [];
  const flow = createInstallationFlow({
    snapshot: async () => 'state-1', lock: async fn => fn(),
    check: async step => { calls.push(step); return { ok: true, message: step }; },
    install: async () => { calls.push('install'); return { enabledAutomatically: false }; },
    ...overrides,
  });
  return { flow, calls };
}
async function ready(flow) {
  let item = await flow.begin('owner');
  for (const _ of STEPS) item = await flow.advance(item.id, 'owner');
  return item;
}
test('checks run in order and must finish before installation', async () => {
  const { flow, calls } = fixture();
  let item = await flow.begin('owner');
  await assert.rejects(flow.install(item.id, 'owner', true), /全部检查/);
  for (const step of STEPS) {
    item = await flow.advance(item.id, 'owner');
    assert.equal(calls.at(-1), step.id);
  }
  assert.equal(item.state, 'ready');
  await assert.rejects(flow.install(item.id, 'owner', false), /全部检查/);
  assert.ok(!calls.includes('install'));
  const result = await flow.install(item.id, 'owner', true);
  assert.equal(result.state, 'installed');
  assert.equal(result.result.enabledAutomatically, false);
  assert.deepEqual(calls, [...STEPS.map(step => step.id), ...STEPS.map(step => step.id), 'install']);
  await assert.rejects(flow.install(item.id, 'owner', true));
});
test('failed dependency check blocks later steps until it is actually ready', async () => {
  let installed = false;
  const { flow } = fixture({ check: async step => ({ ok: step !== 'dependency' || installed }) });
  let item = await flow.begin('owner');
  item = await flow.advance(item.id, 'owner');
  item = await flow.advance(item.id, 'owner');
  assert.equal(item.steps[1].state, 'blocked');
  assert.equal(item.steps[2].state, 'pending');
  item = await flow.advance(item.id, 'owner');
  assert.equal(item.steps[1].state, 'blocked');
  installed = true;
  item = await flow.advance(item.id, 'owner');
  assert.equal(item.steps[1].state, 'passed');
  assert.equal(item.steps[2].state, 'pending');
});
test('revoked login is rechecked before installation', async () => {
  let authenticated = true;
  const { flow, calls } = fixture({ check: async step => ({ ok: step !== 'identity' || authenticated }) });
  const item = await ready(flow);
  authenticated = false;
  await assert.rejects(flow.install(item.id, 'owner', true), /复核未通过/);
  assert.ok(!calls.includes('install'));
});
test('changed Bot or package invalidates the pre-install receipt', async () => {
  let snapshot = 'state-1';
  const { flow, calls } = fixture({ snapshot: async () => snapshot });
  const item = await ready(flow);
  snapshot = 'state-2';
  await assert.rejects(flow.install(item.id, 'owner', true), /配置已变化/);
  assert.ok(!calls.includes('install'));
});
test('another principal and expired receipts cannot authorize install', async () => {
  let now = 1000;
  const { flow, calls } = fixture({ now: () => now });
  const item = await ready(flow);
  await assert.rejects(flow.install(item.id, 'other-owner', true));
  now = item.expiresAt;
  await assert.rejects(flow.install(item.id, 'owner', true));
  assert.ok(!calls.includes('install'));
});
test('a double confirmation performs only one install', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let count = 0;
  const { flow } = fixture({ install: async () => { count++; await gate; return {}; } });
  const item = await ready(flow);
  const first = flow.install(item.id, 'owner', true);
  await assert.rejects(flow.install(item.id, 'owner', true));
  release();
  await first;
  assert.equal(count, 1);
});
