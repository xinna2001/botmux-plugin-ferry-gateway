import test from 'node:test';
import assert from 'node:assert/strict';
import { accelerationDecision, Controller, FerryRoute, observeEvent } from '../gateway/src/lib/runtime-policy.mjs';

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
