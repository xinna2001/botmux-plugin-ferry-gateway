import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller, AFFINITY_TTL_MS, observeEvent } from '../gateway/src/lib/runtime-policy.mjs';
import { pinnedLoop, runtimeSource, flushLoop, TestUpstreamError } from './helpers/pinned-runtime-loop.mjs';

for (const version of ['0.1.98','0.1.120']) {
  const options = { skip: !runtimeSource(version) };
  test(`${version} conversation continuation starts directly on target, not ordinary/reaccelerate`, options, async () => {
    const conversation = {};
    const first = await pinnedLoop(version, { conversation, accelerated: () => ({ tool: true }) });
    await first.result;
    assert.deepEqual(first.calls.map(c => c.target), [false, true]);
    assert.equal(conversation.affinity.accepted, true);
    for (let i = 0; i < 3; i++) {
      // Fresh native generator/controller instance, including tool result and
      // another user turn: no native in-memory sticky helper is used.
      const next = await pinnedLoop(version, { conversation, accelerated: () => ({ text: 'CONTINUED' }),
        identity: { requestId: `continued-${i}`, messages: [
          { role: 'tool', tool_call_id: 'call_owned', content: [{ type: 'text', text: 'owned result' }] },
          { role: 'user', content: [{ type: 'text', text: 'next owned turn' }] },
        ] } });
      await next.result;
      assert.deepEqual(next.calls.map(c => c.target), [true]);
      assert.equal(next.controller.snapshot.routeSource, 'conversation-affinity');
      assert.equal(next.controller.snapshot.routeStatus, 'accepted');
      assert.equal(next.events.filter(e => e.type === 'notice').length, 0);
    }
  });
  test(`${version} failed sticky route clears affinity and has the same finite retry budget`, options, async () => {
    const conversation = {};
    const first = await pinnedLoop(version, { conversation, accelerated: () => ({ text: 'seed' }) });
    await first.result;
    const next = await pinnedLoop(version, { conversation });
    assert.deepEqual(next.calls.map(c => c.target), [true, false]);
    assert.equal(conversation.affinity.accepted, false);
    for (const delay of [5000,15000,30000]) { await next.clock.advance(delay); await flushLoop(); }
    assert.equal(next.calls.filter(c => c.target).length, 4);
    assert.equal(next.saved.reason, 'retry-budget-exhausted');
    next.abort.abort(new Error('owned-stop'));
    await assert.rejects(next.result, /owned-stop/);
  });
  test(`${version} OFF invalidates accepted affinity without interrupting existing output`, options, async () => {
    const conversation = {};
    const first = await pinnedLoop(version, { conversation, accelerated: () => ({ text: 'seed', hold: true }) });
    assert.equal(conversation.affinity.accepted, true);
    first.live({ enabled: false, revision: 1 });
    assert.equal(conversation.affinity.accepted, false);
    assert.equal(first.calls.length, 2);
    const next = await pinnedLoop(version, { conversation, live: { enabled: false, revision: 1 },
      ordinary: { text: 'ordinary' } });
    await next.result;
    assert.deepEqual(next.calls.map(c => c.target), [false]);
    first.abort.abort(new Error('owned-stop'));
    await assert.rejects(first.result, /owned-stop/);
  });
  test(`${version} OFF during sticky target lookup wins before any accelerated wire request`, options, async () => {
    const conversation = {};
    const first = await pinnedLoop(version, { conversation, accelerated: () => ({ text: 'seed' }) });
    await first.result;
    let release;
    const next = await pinnedLoop(version, { conversation, ordinary: { text: 'ordinary' },
      targetLookup: () => new Promise(resolve => { release = resolve; }) });
    assert.equal(next.calls.length, 0);
    next.live({ enabled: false, revision: 1 });
    release({ site: 'i18n-tt', baseUrl: 'http://owned-fixture.invalid' });
    await next.result;
    assert.deepEqual(next.calls.map(c => c.target), [false]);
  });
  test(`${version} usage/done-only target response never establishes accepted affinity`, options, async () => {
    const conversation = {};
    const f = await pinnedLoop(version, { conversation, accelerated: () => ({}) });
    await f.result;
    assert.notEqual(conversation.affinity?.accepted, true);
    assert.notEqual(f.controller.snapshot.routeStatus, 'accepted');
    assert.equal(f.events.filter(e => e.type === 'notice' && /已开始返回/.test(e.text)).length, 0);
  });
  test(`${version} auxiliary/export cannot invoke the native parent's manual acceleration controls`, options, async () => {
    for (const identity of [{botmuxSubagent:true},{botmuxForwardOnly:true}]) {
      const f = await pinnedLoop(version, { identity, ordinary: {text:'ordinary auxiliary'},
        parseIntent: () => { throw new Error('auxiliary must never invoke native command parser'); } });
      await f.result;
      assert.deepEqual(f.nativeEffects, []);
      assert.deepEqual(f.calls.map(c=>c.target), [false]);
    }
    // Positive control ensures the fixture observes native side effects.
    const main = await pinnedLoop(version, { accelerated: () => ({text:'main'}),
      parseIntent: messages => ({ messages, now:true, requested:true, earlier:false }) });
    await main.result;
    assert.ok(main.nativeEffects.includes('remember'));
  });
}

test('durable affinity survives recreation, isolates every identity dimension, expires and respects manual cancel', async t => {
  const home = await mkdtemp(join(tmpdir(), 'affinity090-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const turn = { botmuxAppId: 'cli_affinity_test', botmuxSessionId: '00000000-0000-4000-8000-000000000090',
    sessionId: '00000000-0000-4000-8000-000000000091',
    model: { codexId: 'ferry-gpt-6-1-sol-max' }, reasoningEffort: 'xhigh' };
  const options = { home, enabled: true, now: () => 1000 };
  function seed() {
    const c = new Controller(turn, options);
    c.switched(); c.generatedOutput(); c.finish();
  }
  seed();
  let next = new Controller(turn, options);
  assert.equal(next.wantsContinuation(), true); next.finish();
  for (const patch of [
    { sessionId: 'different-native' }, { botmuxSessionId: '00000000-0000-4000-8000-000000000099' },
    { botmuxAppId: 'cli_another' }, { model: { codexId: 'ferry-gpt-6-astra-max' } },
    { reasoningEffort: 'medium' }, { botmuxSubagent: true }, { botmuxForwardOnly: true },
  ]) {
    next = new Controller({ ...turn, ...patch }, options);
    assert.equal(next.wantsContinuation(), false); next.finish();
  }
  next = new Controller(turn, { ...options, now: () => 1000 + AFFINITY_TTL_MS });
  assert.equal(next.wantsContinuation(), false); next.finish();
  next = new Controller(turn, { ...options, liveControl: () => ({ enabled: true, revision: 2 }) });
  assert.equal(next.wantsContinuation(), false, 'OFF/ON between requests invalidates old revision'); next.finish();
  next = new Controller(turn, options);
  assert.equal(next.wantsContinuation(), true);
  next.suppress('manual-cancel'); assert.equal(next.wantsContinuation(), false); next.finish();
  next = new Controller(turn, options);
  assert.equal(next.wantsContinuation(), false); next.finish();
});

test('newer primary request prevents stale request overwriting affinity', async t => {
  const home = await mkdtemp(join(tmpdir(), 'affinity-owner090-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const turn = { botmuxAppId: 'cli_owned', botmuxSessionId: '00000000-0000-4000-8000-000000000090',
    sessionId: 'native', model: { codexId: 'ferry-gpt-6-1-sol-max' }, reasoningEffort: 'xhigh' };
  const stale = new Controller(turn, { home, enabled: true });
  const latest = new Controller(turn, { home, enabled: true });
  stale.switched(); stale.generatedOutput();
  assert.equal(latest.wantsContinuation(), false);
  latest.switched(); latest.generatedOutput(); latest.finish();
  stale.clearAffinity('stale-off'); stale.finish();
  const next = new Controller(turn, { home, enabled: true });
  assert.equal(next.wantsContinuation(), true); next.finish();
});

test('storage failure never announces conversation-level persistence', () => {
  const c = new Controller({ botmuxAppId: 'cli_owned', botmuxSessionId: '00000000-0000-4000-8000-000000000090',
    sessionId: 'native', model: { codexId: 'ferry-gpt-6-1-sol-max' }, reasoningEffort: 'xhigh' },
  { enabled: true, write() {}, writeAffinity() { throw new Error('owned disk failure'); } });
  c.switched(); assert.equal(c.generatedOutput(), true);
  assert.equal(c.snapshot.routeStatus, 'accepted');
  assert.equal(c.snapshot.affinityPersisted, false);
  assert.match(c.acceptanceMessage(), /未保存/); c.finish();
});
