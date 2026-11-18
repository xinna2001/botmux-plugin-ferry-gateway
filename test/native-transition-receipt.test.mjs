import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { buildNativeHistory, createNativeHistory } from '../gateway/src/lib/native-history-copy.mjs';
import { nativeTransitionFile, nativeTransitionHistory } from '../gateway/src/lib/native-transition-receipt.mjs';
import { controlLaunchPlan, resolveHistoryConfiguration, needsManagedRuntime } from '../gateway/src/lib/control-launcher.mjs';
import { atomicJson, digest } from '../shared/state.mjs';

const app = 'cli_transition_fixture', sid = '00000000-0000-4000-8000-000000000901';
const sourceId = '00000000-0000-7000-8000-000000000901', targetId = '00000000-0000-7000-8000-000000000902';
const choice = { clientModel: 'GPT-6.1-Sol', ferryModel: 'ferry-gpt-6-1-sol-max',
  backendVariant: 'max', efforts: ['xhigh'], contextWindow: 1000000 };
const options = { sourceId, id: targetId, model: choice.clientModel, sourceProvider: 'botmux_ferry',
  effort: 'xhigh', backendVariant: 'max' };
const timestamp = '2026-11-17T00:00:00.000Z';
const source = Buffer.from([
  { type: 'session_meta', payload: { id: sourceId, model_provider: 'botmux_ferry', history_format: 'canonical_v1' } },
  { type: 'history_mutation', payload: { version: 1, operation: 'append', items: [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Preserve my existing work' }] },
    { type: 'reasoning', encrypted_content: 'not-portable-fixture' },
    { type: 'function_call', call_id: 'completed-tool', name: 'fixture', arguments: '{}' },
    { type: 'function_call_output', call_id: 'completed-tool', output: 'already written; do not replay' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done' }] },
  ] } },
  { timestamp, type: 'event_msg', payload: { type: 'task_complete', turn_id: 'real-source-turn', last_agent_message: 'Done' } },
].map(r => JSON.stringify(r)).join('\n') + '\n');

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'native-transition-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const native = join(home, 'native'), root = join(native, 'sessions');
  await mkdir(root, { recursive: true });
  const input = join(root, `rollout-source-${sourceId}.jsonl`);
  await writeFile(input, source);
  const result = createNativeHistory(input, native, options);
  const topic = { schemaVersion: 1, appId: app, sessionId: sid, scopeEnabled: true,
    bot: { cliId: 'traex', model: choice.clientModel, reasoningEffort: 'xhigh' },
    binding: { selection: choice, native: { command: '/owned/traex', prefixArgs: [] } } };
  const receipt = { schemaVersion: 1, authorized: true, appId: app, sessionId: sid, sourceId, targetId,
    topicHash: digest(topic), sourceModel: choice.ferryModel, targetProvider: 'trae', targetModel: choice.clientModel,
    effort: 'xhigh', backendVariant: 'max', prefixBytes: result.targetBytes,
    prefixSha256: result.targetSha256, state: 'prepared' };
  const receiptFile = nativeTransitionFile(home, app, sid);
  await atomicJson(receiptFile, receipt);
  const env = { TRAECLI_HOME: native }, args = ['resume', targetId];
  const read = () => nativeTransitionHistory(home, app, sid, args, env, topic);
  return { home, native, root, input, result, topic, receipt, receiptFile, env, args, read };
}

test('a real-terminal copy keeps messages and completed tools without inventing successful native turns', async t => {
  const f = await fixture(t);
  assert.ok((await readFile(f.input)).equals(source));
  const rows = (await readFile(f.result.targetPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.some(r => r.type === 'turn_context'), false);
  assert.equal(rows[2].payload.turn_id, 'real-source-turn');
  assert.equal(f.result.counts.toolCalls, 1);
  assert.equal(f.result.counts.toolOutputs, 1);
  assert.equal(f.result.counts.reasoningRemoved, 1);
  assert.equal(rows[1].payload.items.find(v => v.type === 'function_call_output').output, 'already written; do not replay');
  await assert.rejects(resolveHistoryConfiguration('traex', f.args, f.env),
    e => e.code === 'NO_VERIFIED_HISTORY_CONFIGURATION');
  const history = await f.read();
  assert.equal(history.verification, 'authorized-native-copy');
  assert.equal(needsManagedRuntime({ bot: f.topic.bot, binding: f.topic.binding, provider: history.provider, scopeEnabled: true }), false);
  const plan = await controlLaunchPlan({ bot: f.topic.bot, binding: f.topic.binding, args: f.args, env: f.env, history });
  assert.equal(plan.gateway, false);
  assert.ok(plan.args.includes('model_backend_variant="max"'));
  assert.ok(plan.args.includes('model_reasoning_effort="xhigh"'));
  assert.equal(plan.args.some(v => String(v).includes('base_url')), false);
});

for (const [name, change] of [
  ['not authorized', r => { r.authorized = false; }],
  ['failed transition', r => { r.state = 'failed'; }],
  ['model drift', r => { r.targetModel = 'GPT-OTHER'; }],
  ['effort downgrade', r => { r.effort = 'low'; }],
  ['variant downgrade', r => { r.backendVariant = 'standard'; }],
  ['topic changed', r => { r.topicHash = '0'.repeat(64); }],
]) {
  test(`rejects an imported prefix when ${name}`, async t => {
    const f = await fixture(t);
    change(f.receipt);
    await atomicJson(f.receiptFile, f.receipt);
    await assert.rejects(f.read(), /不匹配/);
  });
}

test('rejects overwritten prefixes and unsafe receipt permissions, but allows later appended records', async t => {
  const f = await fixture(t);
  const bytes = await readFile(f.result.targetPath);
  await writeFile(f.result.targetPath, Buffer.concat([bytes, Buffer.from('{"type":"later_record"}\n')]));
  assert.equal((await f.read()).model, choice.clientModel);
  await chmod(f.receiptFile, 0o644);
  await assert.rejects(f.read(), /权限不安全/);
  await chmod(f.receiptFile, 0o600);
  await writeFile(f.result.targetPath, Buffer.from(bytes.toString().replace('Done', 'Lost')));
  await assert.rejects(f.read(), /内容已变化/);
});

test('different native identity, fork or CLI cannot borrow a migration receipt', async t => {
  const f = await fixture(t);
  assert.equal(await nativeTransitionHistory(f.home, app, sid, ['resume', sourceId], f.env, f.topic), null);
  assert.equal(await nativeTransitionHistory(f.home, app, sid, ['fork', targetId], f.env, f.topic), null);
  assert.equal(await nativeTransitionHistory(f.home, app, sid, f.args, f.env, { ...f.topic, bot: { cliId: 'codex' } }), null);
});

test('converter refuses invalid UTF-8 rather than silently replacing source bytes', () => {
  const broken = Buffer.concat([source.subarray(0, source.length - 1), Buffer.from([0xff, 0x0a])]);
  assert.throws(() => buildNativeHistory(broken, options), /UTF-8/);
  assert.equal(createHash('sha256').update(source).digest('hex'), buildNativeHistory(source, options).manifest.sourceSha256);
});
