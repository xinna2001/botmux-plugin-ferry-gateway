import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { successfulHistoryConfiguration, expectedPendingFromTopic } from '../gateway/src/lib/session-history.mjs';
import { resolveHistoryConfiguration } from '../gateway/src/lib/control-launcher.mjs';

const id = '00000000-0000-4000-8000-000000000701';
const ctx = (turn, model = 'ferry-gpt-6-1-sol-max', effort = 'xhigh', provider = 'botmux_ferry') =>
  ({ type: 'turn_context', payload: { turn_id: turn, model, effort, model_provider: provider } });
const event = (type, turn, extra = {}) => ({ type: 'event_msg', payload: { type, turn_id: turn, ...extra } });
const complete = turn => event('task_complete', turn, { last_agent_message: 'fixture success' });
async function fixture(t, values, { provider = 'botmux_ferry', tail = '', metaId = id } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'gateway-success-history-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = join(home, 'sessions'), dir = join(root, '2026/11/17');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `rollout-fixture-${id}.jsonl`),
    [{ type: 'session_meta', payload: { id: metaId, model_provider: provider } }, ...values]
      .map(value => JSON.stringify(value)).join('\n') + '\n' + tail);
  return { root, home };
}

test('read complete successful configuration beyond 64 KiB and reject failed native fallback', async t => {
  const { root } = await fixture(t, [
    { type: 'response_item', payload: { type: 'message', role: 'user', content: 'x'.repeat(70000) } },
    ctx('old'), complete('old'), ctx('failed', 'GPT-DEFAULT', 'low', 'trae'),
    event('error', 'failed'), complete('failed'), ctx('unfinished', 'ferry-gpt-other', 'low'),
  ]);
  assert.deepEqual(await successfulHistoryConfiguration(id, root),
    { model: 'ferry-gpt-6-1-sol-max', provider: 'botmux_ferry', effort: 'xhigh', turnId: 'old', contextWindow: undefined });
});

test('newest complete successful FERRY turn wins but completed default GPT still cannot replace FERRY', async t => {
  const { root } = await fixture(t, [ctx('old'), complete('old'),
    ctx('new', 'ferry-gpt-6-astra-max', 'high'), complete('new'),
    ctx('fallback', 'GPT-DEFAULT', 'medium', 'trae'), complete('fallback')]);
  assert.equal((await successfulHistoryConfiguration(id, root)).model, 'ferry-gpt-6-astra-max');
});

test('never borrow effort from another turn or use incomplete or failed FERRY turns', async t => {
  const missing = ctx('missing'); delete missing.payload.effort;
  const { root } = await fixture(t, [ctx('old'), complete('old'), missing, complete('missing'),
    ctx('failed', 'ferry-gpt-6-astra-max', 'high'), event('turn_aborted', 'failed'), complete('failed')]);
  assert.equal((await successfulHistoryConfiguration(id, root)).turnId, 'old');
});

test('collaboration settings provide historical model and reasoning effort on older schemas', async t => {
  const { root } = await fixture(t, [{ type: 'turn_context', payload: { turn_id: 'settings',
    model_provider: 'original_ferry', collaboration_mode: { settings: {
      model: 'ferry-gpt-6-1-sol-max', reasoning_effort: 'xhigh' } } } }, complete('settings')],
  { provider: 'original_ferry' });
  const config = await successfulHistoryConfiguration(id, root);
  assert.equal(config.provider, 'original_ferry');
  assert.equal(config.effort, 'xhigh');
});

test('truncated final write after process stop leaves prior success usable', async t => {
  const { root } = await fixture(t, [ctx('old'), complete('old')], { tail: '{"type":"turn_context","payload":' });
  assert.equal((await successfulHistoryConfiguration(id, root)).turnId, 'old');
});

test('native successful history restores its own model and effort', async t => {
  const { root } = await fixture(t, [ctx('native', 'GPT-6.1-Sol', 'high', 'trae'), complete('native')],
    { provider: 'trae' });
  assert.equal((await successfulHistoryConfiguration(id, root)).model, 'GPT-6.1-Sol');
});

test('missing or mismatched history and no successful configurations fail closed', async t => {
  const { root } = await fixture(t, [ctx('failed'), event('error', 'failed')]);
  await assert.rejects(successfulHistoryConfiguration(id, root), /完整的成功回合/);
  assert.equal(await successfulHistoryConfiguration('not-id', root), null);
  const other = await fixture(t, [ctx('old'), complete('old')], { metaId: 'different' });
  await assert.rejects(successfulHistoryConfiguration(id, other.root), /身份不匹配/);
});

test('explicit TraeX home and fork use successful history, prompts do not trigger resume resolution', async t => {
  const { home } = await fixture(t, [ctx('old'), complete('old')]);
  const history = await resolveHistoryConfiguration('traex', ['exec', 'fork', id, '--', 'resume'], { TRAECLI_HOME: home });
  assert.equal(history.effort, 'xhigh');
  assert.equal(await resolveHistoryConfiguration('traex', ['exec', '--', 'resume', id], {}), undefined);
  await assert.rejects(resolveHistoryConfiguration('traex', ['resume', '--last'], { TRAECLI_HOME: home }), /明确的会话 ID/);
});

test('assistant output alone or an auxiliary completion is not successful main-turn evidence', async t => {
  const { root } = await fixture(t, [ctx('pending'),
    { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer' } },
    { type: 'turn_context', payload: { ...ctx('aux').payload, root_turn_id: 'pending' } },
    complete('aux')]);
  await assert.rejects(successfulHistoryConfiguration(id, root), /完整的成功回合/);
});

test('a restarted logical turn ID cannot inherit success for a later unfinished or failed context', async t => {
  const { root } = await fixture(t, [event('task_started', 'reused'), ctx('reused'), complete('reused'),
    event('task_started', 'reused'), ctx('reused', 'ferry-gpt-6-astra-max', 'high'),
    event('error', 'reused'), complete('reused')]);
  const config = await successfulHistoryConfiguration(id, root);
  assert.equal(config.model, 'ferry-gpt-6-1-sol-max');
  assert.equal(config.effort, 'xhigh');
});

test('0.9 safely resumes a bound first queued turn without using current defaults', async t => {
  const { root } = await fixture(t, [event('task_started', 'queued'), ctx('queued'), event('turn_aborted', 'queued')]);
  const expectedPending = { nativeSessionId: id, provider: 'botmux_ferry', model: 'ferry-gpt-6-1-sol-max', effort: 'xhigh' };
  await assert.rejects(successfulHistoryConfiguration(id, root), /可信的首轮排队绑定/);
  const restored = await successfulHistoryConfiguration(id, root, { expectedPending });
  assert.equal(restored.verification, 'bound-unfinished');
  assert.equal(restored.model, expectedPending.model);
  assert.equal(restored.effort, 'xhigh');
  for (const patch of [{ nativeSessionId: 'another' }, { model: 'ferry-gpt-6-astra-max' }, { effort: 'medium' }, { provider: 'trae' }]) {
    await assert.rejects(successfulHistoryConfiguration(id, root, { expectedPending: { ...expectedPending, ...patch } }), /首轮排队绑定/);
  }
});

test('bound unfinished recovery cannot borrow from an earlier different/fallback context or unconfirmed output', async t => {
  const expectedPending = { nativeSessionId: id, provider: 'botmux_ferry', model: 'ferry-gpt-6-1-sol-max', effort: 'xhigh' };
  for (const values of [
    [ctx('original'), ctx('fallback', 'GPT-DEFAULT', 'medium', 'trae'), event('error', 'fallback')],
    [ctx('original'), { type: 'response_item', payload: { role: 'assistant', type: 'message', phase: 'analysis' } }],
    [ctx('original'), { type: 'history_mutation', payload: { items: [{ type: 'function_call', name: 'owned' }] } }],
  ]) {
    const { root } = await fixture(t, values);
    await assert.rejects(successfulHistoryConfiguration(id, root, { expectedPending }), /首轮排队绑定/);
  }
});

test('only exact primary non-generating native identity evidence enables the first-turn fallback', () => {
  const topic = { appId: 'cli_owned', sessionId: 'owned-topic', scopeEnabled: true,
    bot: { reasoningEffort: 'xhigh' }, binding: { selection: { ferryModel: 'ferry-gpt-6-1-sol-max' } } };
  const request = { appId: topic.appId, sessionId: topic.sessionId, primary: true, controlProtocol: 1,
    generated: false, phase: 'queued', nativeSessionId: id, model: topic.binding.selection.ferryModel, reasoningEffort: 'xhigh' };
  assert.equal(expectedPendingFromTopic(topic, request).nativeSessionId, id);
  for (const patch of [{ appId: 'other' }, { sessionId: 'other' }, { primary: false },
    { generated: true }, { generated: undefined }, { phase: 'answering' }, { controlProtocol: undefined }, { nativeSessionId: 'invalid' },
    { model: 'ferry-other' }, { reasoningEffort: 'medium' }]) {
    assert.equal(expectedPendingFromTopic(topic, { ...request, ...patch }), undefined);
  }
});
