import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { atomicJson } from '../shared/state.mjs';
import { Controller, FerryRoute, RETRY_DELAYS_MS, REJECTION_TTL_MS, retryAfterMilliseconds,
  isTransientAccelerationError, observeEvent, createController } from '../gateway/src/lib/runtime-policy.mjs';
import { setLiveAcceleration } from '../gateway/src/lib/live-control.mjs';
import { retryClock } from './helpers/retry-clock.mjs';

function owned(options = {}) {
  const clock = retryClock(), signal = new AbortController();
  let saved = {}, live = { enabled: true, revision: 0 };
  const writes = [], routes = [], notices = [];
  const turn = { botmuxAppId: 'cli_owned_retry_test', botmuxSessionId: '00000000-0000-4000-8000-000000000090',
    model: { codexId: 'ferry-gpt-6-1-sol-max' }, reasoningEffort: 'xhigh', signal: signal.signal, ...options.turn };
  const controller = new Controller(turn, {
    enabled: true, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    readControl: () => saved, writeControl: value => { saved = value; },
    write: value => writes.push(value), liveControl: () => live, ...options.deps,
  });
  controller.setNotice(text => notices.push(text));
  return { clock, signal, controller, turn, writes, routes, notices,
    bind() { controller.bindAbort(route => routes.push(route)); },
    get saved() { return saved; }, set saved(value) { saved = value; },
    live(value) { live = value; controller.syncLive(); },
  };
}

test('0.9 restores exactly three additional 5/15/30 retries without model or effort changes', async () => {
  const f = owned(); f.bind();
  assert.ok(f.controller.queue(2000) instanceof FerryRoute);
  assert.equal(f.controller.snapshot.accelerationAttempts, 1);
  for (const delay of RETRY_DELAYS_MS) {
    f.controller.switched();
    assert.equal(f.controller.returnedToOrdinary({ status: 429, message: 'Too many requests', retryable: false }), true);
    const expected = f.clock.now() + delay;
    assert.equal(f.controller.nextRetryAt, expected);
    f.bind(); f.controller.queue(2000);
    const before = f.routes.length;
    await f.clock.advance(delay - 1);
    assert.equal(f.routes.length, before);
    await f.clock.advance(1);
    assert.equal(f.routes.length, before + 1, 'timer wakes an ordinary stream with no new queue event');
    assert.equal(f.routes.at(-1).action, 'accelerate');
  }
  f.controller.switched();
  assert.equal(f.controller.returnedToOrdinary({ status: 429, retryable: true }), false);
  f.bind(); f.controller.queue(2000);
  await f.clock.advance(120000);
  assert.equal(f.routes.length, 3);
  assert.equal(f.controller.snapshot.accelerationAttempts, 4);
  assert.equal(f.saved.reason, 'retry-budget-exhausted');
  assert.equal(f.clock.size, 0);
  assert.equal(f.turn.reasoningEffort, 'xhigh');
  assert.equal(f.turn.model.codexId, 'ferry-gpt-6-1-sol-max');
  f.controller.finish();
});

test('error classification never retries authentication, permission, invalid input or exhausted quota', () => {
  for (const error of [
    { status: 401, retryable: true }, { status: 403, retryable: true },
    { status: 400, retryable: true }, { status: 404, retryable: true },
    { status: 502, retryable: true, message: 'insufficient quota' },
    { status: 502, retryable: true, message: 'permission denied' },
  ]) assert.equal(isTransientAccelerationError(error), false);
  for (const error of [
    { status: 429 }, { status: 408 }, { status: 502, retryable: true },
    { status: 502, retryable: false, message: 'Too many requests were sent in a short period. Please reduce the concurrency and try again.' },
    { status: 403, message: 'DetectAffiliation context deadline exceeded' },
  ]) assert.equal(isTransientAccelerationError(error), true);
});

for (const action of ['abort', 'output', 'queueEnd', 'finish', 'off']) {
  test(`pending retry is removed by ${action}`, async () => {
    const f = owned(); f.bind(); f.controller.queue(100); f.controller.switched();
    f.controller.returnedToOrdinary({ status: 429 }); f.bind(); f.controller.queue(100);
    assert.equal(f.clock.size, 1);
    if (action === 'abort') f.signal.abort();
    if (action === 'output') f.controller.generatedOutput();
    if (action === 'queueEnd') f.controller.queueEnded();
    if (action === 'finish') f.controller.finish();
    if (action === 'off') f.live({ enabled: false, revision: 1, reason: 'bot-acceleration-off' });
    await f.clock.advance(60000);
    assert.equal(f.routes.length, 0);
    assert.equal(f.clock.size, 0);
    f.controller.finish();
  });
}

test('control notices do not poison retries, while real tool/output events do', () => {
  const f = owned();
  observeEvent({ ferryPolicy: f.controller }, { type: 'notice', text: 'retry pending' }, false);
  assert.equal(f.controller.canAccelerate(), true);
  observeEvent({ ferryPolicy: f.controller }, { type: 'tool_call' }, false);
  assert.equal(f.controller.canAccelerate(), false);
  f.controller.finish();
});

test('only true model output changes route status from attempting to accepted', () => {
  const f = owned();
  f.controller.queue(1); f.controller.switched();
  assert.equal(f.controller.snapshot.routeStatus, 'attempting');
  assert.doesNotMatch(f.controller.attemptMessage(), /已加速|已生效/);
  assert.equal(f.controller.generatedOutput(), true);
  assert.equal(f.controller.snapshot.routeStatus, 'accepted');
  assert.equal(f.controller.generatedOutput(), false, 'confirmation is emitted once');
  f.controller.finish();
});

test('Retry-After is not shortened and 24h expiry does not clear manual cancellation', () => {
  const f = owned();
  f.controller.queue(100); f.controller.switched();
  f.controller.returnedToOrdinary({ status: 429, retryAfterMs: 45000 });
  assert.equal(f.controller.nextRetryAt, f.clock.now() + 45000);
  f.saved = { disabled: true, reason: 'upstream-rejected', changedAt: f.clock.now() - REJECTION_TTL_MS - 1 };
  assert.equal(f.controller.isSuppressed(), false);
  f.saved = { disabled: true, reason: 'manual-cancel', changedAt: f.clock.now() - REJECTION_TTL_MS - 1 };
  assert.equal(f.controller.isSuppressed(), true);
  f.controller.finish();
});

test('Retry-After accepts seconds/date but never turns an invalid value into immediate retry', () => {
  assert.equal(retryAfterMilliseconds('60', 0), 60000);
  assert.equal(retryAfterMilliseconds('Thu, 01 Jan 1970 00:01:00 GMT', 0), 60000);
  assert.equal(retryAfterMilliseconds('not a date', 0), undefined);
  assert.equal(retryAfterMilliseconds('', 0), undefined);
  assert.equal(retryAfterMilliseconds('-1', 0), undefined);
});

test('auxiliary and mismatched requests cannot cancel or restore the parent topic', () => {
  for (const options of [{ turn: { botmuxSubagent: true } }, { deps: { primary: false, mayControl: false } }]) {
    const f = owned(options);
    f.saved = { disabled: true, reason: 'manual-cancel', changedAt: 42 };
    assert.equal(f.controller.resume(), false);
    assert.equal(f.controller.suppress('upstream-rejected'), false);
    assert.deepEqual(f.saved, { disabled: true, reason: 'manual-cancel', changedAt: 42 });
    f.controller.finish();
  }
});

test('live off returns a non-generating accelerated attempt to ordinary; never interrupts generated output', () => {
  const f = owned(); f.bind(); f.controller.queue(100); f.controller.switched();
  f.live({ enabled: false, revision: 1 });
  assert.equal(f.routes.at(-1)?.action, 'ordinary');
  assert.equal(f.controller.canAccelerate(), false);
  f.controller.returnedByControl();
  f.bind(); f.controller.queue(100);
  f.live({ enabled: true, explicitlyEnabled: true, revision: 2, changedAt: f.clock.now() });
  assert.equal(f.routes.at(-1)?.action, 'accelerate');
  f.controller.switched(); f.controller.generatedOutput();
  const before = f.routes.length;
  f.live({ enabled: false, revision: 3 });
  assert.equal(f.routes.length, before, 'off is not permission to replay or kill started output');
  f.controller.finish();
});

test('explicit re-enable may reset automatic failure, but never clears a manual topic cancel', () => {
  const f = owned();
  f.saved = { disabled: true, reason: 'upstream-rejected', changedAt: 10, controlRevision: 1 };
  f.live({ enabled: true, explicitlyEnabled: true, revision: 2, changedAt: 20 });
  assert.equal(f.saved.disabled, false);
  f.saved = { disabled: true, reason: 'manual-cancel', changedAt: 30, controlRevision: 2 };
  f.live({ enabled: true, explicitlyEnabled: true, revision: 3, changedAt: 40 });
  assert.equal(f.saved.disabled, true);
  f.controller.finish();
});

test('real atomic config toggle reaches an idle queued controller without another queue event', async t => {
  const home = await mkdtemp(join(tmpdir(), 'gateway-live090-'));
  const appId = 'cli_live090', sessionId = '00000000-0000-4000-8000-000000000091', model = 'ferry-gpt-6-1-sol-max';
  const bot = { larkAppId: appId, cliId: 'codex', model, reasoningEffort: 'xhigh', plugins: ['gateway-acceleration'] };
  const binding = { architecture: 'codex', forwarding: true, acceleration: true,
    selection: { clientModel: model, ferryModel: model, efforts: ['xhigh'], accelerationAvailable: true } };
  const configFile = join(home, 'plugins/gateway-acceleration/config.json');
  const config = { controlPlane: { bots: { [appId]: binding } } };
  await atomicJson(configFile, config); await atomicJson(join(home, 'bots.json'), [bot]);
  await atomicJson(join(home, 'config.json'), {});
  await atomicJson(join(home, 'plugins-registry.json'), { plugins: { 'gateway-acceleration': {} } });
  const c = createController({ botmuxAppId: appId, botmuxSessionId: sessionId, requestId: 'live090',
    model: { codexId: model }, botmuxRequestedModel: model, reasoningEffort: 'xhigh', nativeAccelerationSupported: true }, { home });
  t.after(async () => { c.finish(); await rm(home, { recursive: true, force: true }); });
  assert.equal(c.canAccelerate(), true);
  setLiveAcceleration(config, appId, false); await atomicJson(configFile, config);
  for (let i=0;i<25 && c.canAccelerate();i++) await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(c.canAccelerate(), false);
  assert.equal(c.snapshot.liveControlRevision, 1);
  setLiveAcceleration(config, appId, true); await atomicJson(configFile, config);
  for (let i=0;i<25 && !c.canAccelerate();i++) await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(c.canAccelerate(), true);
  assert.equal(c.snapshot.liveControlRevision, 2);
});
