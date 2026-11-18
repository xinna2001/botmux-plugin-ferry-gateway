import test from 'node:test';
import assert from 'node:assert/strict';
import { pinnedLoop, pinnedHttp, runtimeSource, TestUpstreamError, flushLoop } from './helpers/pinned-runtime-loop.mjs';

for (const version of ['0.1.98', '0.1.120']) {
  const options = { skip: !runtimeSource(version) };
  test(`${version} actual native loops retry at5/15/30, at most four target attempts`, options, async () => {
    const f = await pinnedLoop(version);
    assert.equal(f.calls.filter(v => v.target).length, 1);
    for (const delay of [5000,15000,30000]) {
      await f.clock.advance(delay - 1); await flushLoop();
      const before = f.calls.filter(v => v.target).length;
      await f.clock.advance(1); await flushLoop();
      assert.equal(f.calls.filter(v => v.target).length, before + 1);
    }
    assert.deepEqual(f.calls.filter(v => v.target).map(v => v.at), [1000,6000,21000,51000]);
    assert.equal(f.saved.reason, 'retry-budget-exhausted');
    assert.equal(f.probes, 0, 'managed routing never starts the speculative probe');
    await f.clock.advance(300000); await flushLoop();
    assert.equal(f.calls.filter(v => v.target).length, 4);
    assert.ok(f.calls.every(v => v.model === 'gpt-6.1-sol__max' && v.effort === 'xhigh'));
    assert.equal(f.events.filter(v => v.type === 'switched').length, 0, 'no premature native success event');
    assert.ok(f.events.some(v => v.type === 'notice' && /30 秒后重试/.test(v.text)));
    f.abort.abort(new Error('owned-test-stop'));
    await assert.rejects(f.result, /owned-test-stop/);
    assert.equal(f.clock.size, 0);
  });
  test(`${version} actual native loop succeeds after one retry with truthful confirmation`, options, async () => {
    const f = await pinnedLoop(version, { accelerated: n => n === 1
      ? { error: new TestUpstreamError() } : { text: 'OWNED_REAL_LOOP_OK' } });
    await f.clock.advance(5000); await f.result;
    assert.equal(f.calls.filter(v => v.target).length, 2);
    assert.equal(f.events.find(v => v.type === 'done').result.text, 'OWNED_REAL_LOOP_OK');
    assert.ok(f.events.some(v => v.type === 'notice' && /正在尝试/.test(v.text)));
    assert.equal(f.events.filter(v => v.type === 'notice' && /已开始返回模型结果/.test(v.text)).length, 1);
    assert.equal(f.controller.snapshot.routeStatus, 'accepted');
    assert.equal(f.clock.size, 0);
  });
  test(`${version} raw partial tool call prevents native or plugin replay`, options, async () => {
    const f = await pinnedLoop(version, { accelerated: () => ({
      tool: true, error: new TestUpstreamError('network dropped after partial tool', { status: 502 }),
    }) });
    await assert.rejects(f.result, /partial tool/);
    await f.clock.advance(120000);
    assert.equal(f.calls.filter(v => v.target).length, 1);
    assert.equal(f.controller.generated, true);
    assert.equal(f.clock.size, 0);
  });
  test(`${version} UI live off actually retires an accelerated wait and resumes ordinary`, options, async () => {
    const f = await pinnedLoop(version, { accelerated: () => ({ queue: 500, hold: true }) });
    assert.equal(f.calls.filter(v => v.target).length, 1);
    f.live({ enabled: false, revision: 1, reason: 'bot-acceleration-off' });
    await flushLoop();
    assert.equal(f.calls.at(-1).target, false);
    assert.equal(f.controller.snapshot.liveAccelerationEnabled, false);
    await f.clock.advance(120000); await flushLoop();
    assert.equal(f.calls.filter(v => v.target).length, 1);
    f.live({ enabled: true, explicitlyEnabled: true, revision: 2, changedAt: f.clock.now() });
    await flushLoop();
    assert.equal(f.calls.filter(v => v.target).length, 2);
    f.abort.abort(new Error('owned-test-stop'));
    await assert.rejects(f.result, /owned-test-stop/);
  });
  test(`${version} UI live off does not kill output already streaming`, options, async () => {
    const f = await pinnedLoop(version, { accelerated: () => ({ text: 'partial model output', hold: true }) });
    assert.equal(f.controller.generated, true);
    const count = f.calls.length;
    f.live({ enabled: false, revision: 1 });
    await flushLoop(); await f.clock.advance(120000);
    assert.equal(f.calls.length, count);
    assert.equal(f.calls.at(-1).target, true);
    f.abort.abort(new Error('owned-test-stop'));
    await assert.rejects(f.result, /owned-test-stop/);
  });
  test(`${version} actual HTTP wrapper passes Retry-After to the one bounded managed attempt`, options, async () => {
    for (const status of [429,503]) {
      const f = await pinnedHttp(version, { status });
      assert.equal(f.calls.length, 1);
      assert.equal(f.delays.length, 0, 'no nested short HTTP retry before the requested backoff');
      assert.equal(f.error.status, status);
      assert.equal(f.error.retryAfterMs, 60000);
      assert.equal(f.logs.filter(v => v.event === 'upstream.response').length, 1);
    }
    const unmanaged = await pinnedHttp(version, { managed: false });
    assert.equal(unmanaged.calls.length, 3, 'unmanaged native transport behavior is not rewritten');
  });
}
