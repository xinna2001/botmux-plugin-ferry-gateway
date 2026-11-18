import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { atomicJson } from '../shared/state.mjs';
import { accelerationDecision, createController, Controller, FerryRoute, observeEvent, managedNativeSessionId, requestIsAuxiliary } from '../gateway/src/lib/runtime-policy.mjs';

test('only a scoped managed resume overrides inherited cache/session headers', () => {
  const native = '00000000-0000-4000-8000-000000000041';
  const headers = new Headers({ 'x-botmux-app': 'cli_fixture',
    'x-botmux-session': '00000000-0000-4000-8000-000000000042',
    'x-botmux-native-session': native, session_id: 'inherited-parent' });
  assert.equal(managedNativeSessionId(headers, 'parent'), native);
  for (const [key, value] of [['x-botmux-app', 'invalid'], ['x-botmux-session', 'invalid'],
    ['x-botmux-native-session', '../other'], ['x-openai-subagent', 'child'],
    ['x-botmux-forward-only', 'true']]) {
    const changed = new Headers(headers); changed.set(key, value);
    assert.equal(managedNativeSessionId(changed, 'parent'), 'parent');
  }
  assert.equal(managedNativeSessionId(new Headers(), 'parent'), 'parent');
});

test('native Codex title/system metadata cannot overwrite or control the real main request', async context => {
  const { turn, state } = fixture();
  const home = await mkdtemp(join(tmpdir(), 'codex-role-isolation-'));
  context.after(() => rm(home, { recursive: true, force: true }));
  await atomicJson(join(home, 'bots.json'), [{ ...state.bot, larkAppId: turn.botmuxAppId }]);
  await atomicJson(join(home, 'plugins-registry.json'), { plugins: { 'gateway-acceleration': {} } });
  await atomicJson(join(home, 'plugins/gateway-acceleration/config.json'),
    { controlPlane: { bots: { [turn.botmuxAppId]: state.binding } } });
  const rootHeaders = new Headers({ 'x-codex-turn-metadata': JSON.stringify({ request_kind: 'turn', thread_source: 'user' }) });
  assert.equal(requestIsAuxiliary(rootHeaders), false);
  assert.equal(requestIsAuxiliary(new Headers()), false);
  const root = createController({ ...turn, sessionId: '00000000-0000-4000-8000-000000000041',
    botmuxSubagent: requestIsAuxiliary(rootHeaders) }, { home });
  for (const raw of [JSON.stringify({ request_kind: 'turn', thread_source: 'thread_title' }),
    JSON.stringify({ request_kind: 'turn', thread_source: 'system' }),
    JSON.stringify({ request_kind: 'compaction', thread_source: 'user' }), 'broken', '[]']) {
    const headers = new Headers({ 'x-codex-turn-metadata': raw });
    assert.equal(requestIsAuxiliary(headers), true);
    const child = createController({ ...turn, sessionId: '00000000-0000-4000-8000-000000000042',
      botmuxSubagent: requestIsAuxiliary(headers) }, { home });
    assert.equal(child.primary, false);
    assert.equal(child.canAccelerate(), false);
    child.suppress('manual-cancel');
    child.finish();
    assert.equal(root.canAccelerate(), true, 'title completion must not evict a queued main request owner');
  }
  assert.ok(root.queue(700, undefined) instanceof FerryRoute);
  root.finish();
});

test('native policy identity stays separate from the provider conversation/cache identity', async context => {
  const { turn, state } = fixture();
  const home = await mkdtemp(join(tmpdir(), 'native-policy-identity-'));
  context.after(() => rm(home, { recursive: true, force: true }));
  await atomicJson(join(home, 'bots.json'), [{ ...state.bot, larkAppId: turn.botmuxAppId }]);
  await atomicJson(join(home, 'plugins-registry.json'), { plugins: { 'gateway-acceleration': {} } });
  await atomicJson(join(home, 'plugins/gateway-acceleration/config.json'),
    { controlPlane: { bots: { [turn.botmuxAppId]: state.binding } } });
  const upstream = { ...turn, sessionId: '00000000-0000-4000-8000-000000000041',
    botmuxNativeSessionId: '00000000-0000-4000-8000-000000000042' };
  const controller = createController(upstream, { home });
  assert.equal(controller.snapshot.nativeSessionId, upstream.botmuxNativeSessionId);
  assert.equal(upstream.sessionId, '00000000-0000-4000-8000-000000000041');
  assert.equal(controller.canAccelerate(), true);
  controller.finish();
});

function fixture() {
  const turn = { botmuxAppId: 'cli_fixture', botmuxSessionId: '00000000-0000-4000-8000-000000000001',
    botmuxRequestedModel: 'ferry-gpt-6-1-sol', model: { codexId: 'ferry-gpt-6-1-sol' },
    reasoningEffort: 'xhigh', nativeAccelerationSupported: true, signal: new AbortController().signal };
  const state = { installed: true, global: {},
    bot: { cliId: 'codex', model: 'ferry-gpt-6-1-sol', reasoningEffort: 'xhigh', plugins: ['gateway-acceleration'] },
    binding: { architecture: 'codex', forwarding: true, acceleration: true,
      selection: { ferryModel: 'ferry-gpt-6-1-sol', clientModel: 'ferry-gpt-6-1-sol', efforts: ['xhigh'], accelerationAvailable: true } } };
  return { turn, state };
}

test('real request eligibility requires scope, model, effort and independent controls', () => {
  const { turn, state } = fixture();
  assert.equal(accelerationDecision(turn, state), true);
  for (const invalid of [
    { ...state, installed: false },
    { ...state, bot: { ...state.bot, plugins: [] } },
    { ...state, binding: { ...state.binding, forwarding: false } },
    { ...state, binding: { ...state.binding, acceleration: false } },
    { ...state, bot: { ...state.bot, traexAutoModel: { enabled: true } } },
  ]) assert.equal(accelerationDecision(turn, invalid), false);
  assert.equal(accelerationDecision({ ...turn, reasoningEffort: 'high' }, state), false);
  assert.equal(accelerationDecision({ ...turn, botmuxRequestedModel: 'unknown' }, state), false);
});

test('switching defaults off does not revoke an existing topic across queued requests or controller recreation', async context => {
  const { turn, state } = fixture();
  const home = await mkdtemp(join(tmpdir(), 'ferry-live-control-policy-'));
  context.after(() => rm(home, { recursive: true, force: true }));
  await atomicJson(join(home, 'bots.json'), [{ ...state.bot, larkAppId: turn.botmuxAppId }]);
  await atomicJson(join(home, 'plugins-registry.json'), { plugins: { 'gateway-acceleration': {} } });
  const configFile = join(home, 'plugins/gateway-acceleration/config.json');
  const config = { controlPlane: { bots: { [turn.botmuxAppId]: state.binding } } };
  await atomicJson(configFile, config);
  turn.ferryPolicy = createController(turn, { home, write() {} });
  assert.equal(turn.ferryPolicy.canAccelerate(), true);
  config.controlPlane.bots[turn.botmuxAppId].acceleration = false;
  await atomicJson(configFile, config);
  assert.equal(turn.ferryPolicy.canAccelerate(), true);
  assert.throws(() => observeEvent(turn, { type: 'queue', position: 10, alternative: 0 }, false), FerryRoute);
  assert.equal(createController({ ...turn, requestId: 'next-request' }, { home, write() {} }).canAccelerate(), true);
  assert.equal(turn.model.codexId, 'ferry-gpt-6-1-sol');
});

test('TraeX acceleration does not require a forwarding switch and preserves its variant', () => {
  const { turn, state } = fixture();
  state.bot = { ...state.bot, cliId: 'traex', model: 'GPT-6.1-Sol', modelBackendVariant: 'max' };
  state.binding = { ...state.binding, architecture: 'traex', forwarding: false,
    selection: { ...state.binding.selection, clientModel: 'GPT-6.1-Sol', backendVariant: 'max' } };
  assert.equal(accelerationDecision(turn, state), true);
  state.bot.modelBackendVariant = 'standard';
  assert.equal(accelerationDecision(turn, state), false);
});

test('queue acceleration never rewrites the request model or effort', () => {
  const { turn } = fixture();
  const snapshots = [];
  turn.ferryPolicy = new Controller(turn, { enabled: true, write: snapshot => snapshots.push(snapshot) });
  assert.throws(() => observeEvent(turn, { type: 'queue', position: 10, alternative: 0 }, false), FerryRoute);
  assert.equal(turn.model.codexId, 'ferry-gpt-6-1-sol');
  assert.equal(turn.reasoningEffort, 'xhigh');
  turn.ferryPolicy.switched();
  assert.doesNotThrow(() => observeEvent(turn, { type: 'queue', position: 5, alternative: 0 }, true));
  assert.equal(snapshots.at(-1).moved, true);
});

test('no retry or routing change is allowed after real output starts', () => {
  const { turn } = fixture();
  turn.ferryPolicy = new Controller(turn, { enabled: true, write() {} });
  observeEvent(turn, { type: 'reasoning', text: 'started' }, false);
  assert.equal(turn.ferryPolicy.canAccelerate(), false);
  assert.doesNotThrow(() => observeEvent(turn, { type: 'queue', position: 10, alternative: 0 }, false));
});

test('non-text and unknown output events also prevent retry after generation', () => {
  for (const type of ['image', 'web_search_call', 'compaction', 'custom_tool_call', 'future_output']) {
    const { turn } = fixture();
    turn.ferryPolicy = new Controller(turn, { enabled: true, write() {} });
    observeEvent(turn, { type }, false);
    assert.equal(turn.ferryPolicy.canAccelerate(), false);
  }
});

test('disabled, aborted, unavailable and finished requests do not retry indefinitely', () => {
  const { turn } = fixture();
  const disabled = new Controller(turn, { enabled: false, write() {} });
  assert.equal(disabled.queue(10, 0), undefined);
  const controller = new Controller(turn, { enabled: true, write() {} });
  assert.ok(controller.queue(10, 0) instanceof FerryRoute);
  controller.unavailable();
  assert.equal(controller.queue(10, 0), undefined);
  controller.finish(new Error('failed'));
  controller.finish();
  assert.equal(controller.snapshot.phase, 'error');
  const aborted = new Controller({ ...turn, signal: AbortSignal.abort() }, { enabled: true, write() {} });
  assert.equal(aborted.queue(10, 0), undefined);
});
