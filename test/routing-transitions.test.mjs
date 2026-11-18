import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { atomicJson, digest, readJson } from '../shared/state.mjs';
import { setRoutingIntent, reconcileTopicRouting, reconcileRoutingTransitions, routingProjection } from '../gateway/src/lib/routing-transitions.mjs';
import { nativeTransitionHistory, nativeTargetReceiptFile } from '../gateway/src/lib/native-transition-receipt.mjs';
import { historyFile } from '../gateway/src/lib/session-history.mjs';
import { createNativeHistory } from '../gateway/src/lib/native-history-copy.mjs';
import { supportedRuntime } from '../gateway/src/lib/runtime-instrument.mjs';
import { createController, FerryRoute } from '../gateway/src/lib/runtime-policy.mjs';

const app = 'cli_route_fixture', sid = '00000000-0000-4000-8000-000000000911';
const sourceId = '00000000-0000-7000-8000-000000000911';
const choice = { clientModel: 'GPT-6.1-Sol', ferryModel: 'ferry-gpt-6-1-sol-max',
  backendVariant: 'max', efforts: ['xhigh'], contextWindow: 1000000, accelerationAvailable: true };
const stamp = '2026-11-17T00:00:00Z';
const encode = rows => rows.map(r => JSON.stringify(r)).join('\n') + '\n';
function turn(id, provider, model, variant, text) {
  return [
    { timestamp: stamp, type: 'event_msg', payload: { type: 'task_started', turn_id: id } },
    { type: 'turn_context', payload: { turn_id: id, model_provider: provider, model,
      model_backend_variant: variant, effort: 'xhigh' } },
    { type: 'history_mutation', payload: { version: 1, operation: 'append', items: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `done ${text}` }] },
    ] } },
    { timestamp: stamp, type: 'event_msg', payload: { type: 'task_complete', turn_id: id, last_agent_message: `done ${text}` } },
  ];
}

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'routing-transitions-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = join(home, 'native/sessions'), privateRoot = join(home, 'plugins/gateway-acceleration/private');
  await mkdir(root, { recursive: true });
  const sourcePath = join(root, `rollout-original-${sourceId}.jsonl`);
  const source = encode([{ type: 'session_meta', payload: { id: sourceId, model_provider: 'botmux_ferry',
    history_format: 'canonical_v1' } }, ...turn('first', 'botmux_ferry', choice.ferryModel, 'standard', 'original-work')]);
  await writeFile(sourcePath, source);
  await writeFile(join(home, '.dashboard-token'), 'owned-routing-authority');
  const generation = join(privateRoot, 'runtime/generations/fixture');
  await mkdir(generation, { recursive: true });
  await writeFile(join(generation, 'cli.botmux.mjs'), 'owned-runtime');
  await writeFile(join(generation, 'botmux-policy.mjs'), 'owned-policy');
  const runtime = { program: join(generation, 'cli.botmux.mjs'), programHash: digest('owned-runtime'),
    policyHash: digest('owned-policy'), sourceHash: supportedRuntime.sha256, version: supportedRuntime.version,
    adapterRevision: 'fixture-new', port: 12345, dataHome: join(generation, 'data') };
  await atomicJson(join(privateRoot, 'runtime/prepared.json'), runtime);
  const topic = { schemaVersion: 1, appId: app, sessionId: sid, scopeEnabled: true, provider: 'botmux_ferry',
    bot: { cliId: 'traex', model: choice.clientModel, reasoningEffort: 'xhigh', modelBackendVariant: 'max' },
    binding: { architecture: 'traex', acceleration: true, selection: choice, modelChoices: [choice] },
    runtime: { ...runtime, policyHash: 'older' } };
  await atomicJson(join(privateRoot, 'topics', app, `${sid}.json`), topic);
  await atomicJson(join(home, 'bots.json'), [{ ...topic.bot, larkAppId: app, plugins: ['gateway-acceleration'] }]);
  await atomicJson(join(home, 'plugins-registry.json'), { plugins: { 'gateway-acceleration': {} } });
  const configFile = join(home, 'plugins/gateway-acceleration/config.json');
  const config = {};
  async function intent(mode) {
    setRoutingIntent(config, app, mode, digest('owned-routing-authority'));
    await atomicJson(configFile, config);
    return config.routingIntents.bots[app];
  }
  const state = { protocol: 1, nativeSessionId: sourceId, workerReady: true, cliReady: true, busy: false };
  const posts = [];
  const deps = { env: { TRAECLI_HOME: join(home, 'native') }, runtimeStatus: async () => ({ ready: true }),
    now: () => 1000000,
    request: async (_path, method, body) => {
      if (method !== 'POST') return structuredClone(state);
      posts.push(body);
      return { state: 'accepted', attemptId: `attempt-${posts.length}` };
    } };
  const run = mode => intent(mode).then(i => reconcileTopicRouting(home, topic, i, deps));
  return { home, root, sourcePath, source, config, configFile, topic, state, runtime, posts, deps, intent, run };
}

test('native-created-while-OFF gets exact acceleration authority on ON without rewriting its snapshot', async t => {
  const f = await fixture(t);
  f.topic.scopeEnabled = false;
  f.topic.provider = 'trae';
  f.topic.binding.acceleration = false;
  const topicPath = join(f.home, 'plugins/gateway-acceleration/private/topics', app, `${sid}.json`);
  await atomicJson(topicPath, f.topic);
  const originalSnapshot = await readFile(topicPath, 'utf8');
  await writeFile(f.sourcePath, encode([{ type: 'session_meta', payload: { id: sourceId,
    model_provider: 'trae', history_format: 'canonical_v1' } },
    ...turn('born-off', 'trae', choice.clientModel, 'max', 'native-original-work')]));
  const nativeRows = (await readFile(f.sourcePath, 'utf8')).trim().split('\n').map(JSON.parse);
  nativeRows.find(r => r.type === 'history_mutation').payload.items.push({
    type: 'trae_extra_info', id: 'native-provider-state', extra_info: { model: choice.clientModel,
      version: 1, content: 'opaque-provider-continuation', expire_time: 12345 } });
  await writeFile(f.sourcePath, encode(nativeRows));
  await atomicJson(join(f.home, 'bots.json'), [{ ...f.topic.bot, larkAppId: app, plugins: ['gateway-acceleration'] }]);
  await atomicJson(join(f.home, 'plugins-registry.json'), { plugins: { 'gateway-acceleration': {} } });
  const input = { botmuxAppId: app, botmuxSessionId: sid, sessionId: sourceId,
    botmuxRequestedModel: choice.ferryModel, model: { codexId: choice.ferryModel },
    reasoningEffort: 'xhigh', nativeAccelerationSupported: true };
  const inspect = (nativeId, patch = {}) => {
    const controller = createController({ ...input, sessionId: nativeId, ...patch }, { home: f.home, write() {} });
    const allowed = controller.canAccelerate();
    if (allowed) assert.ok(controller.queue(42, undefined) instanceof FerryRoute, 'grant reaches actual route decision');
    controller.finish();
    return allowed;
  };
  assert.equal(inspect(sourceId), false);
  const on = await f.intent('gateway');
  assert.equal((await reconcileTopicRouting(f.home, f.topic, on, f.deps)).phase, 'switching');
  const target = f.posts[0].targetId;
  const copiedText = await readFile(await historyFile(target, f.root), 'utf8');
  assert.equal(copiedText.includes('opaque-provider-continuation'), false);
  assert.equal(copiedText.includes('native-original-work'), true);
  f.state.nativeSessionId = target;
  assert.equal((await reconcileTopicRouting(f.home, f.topic, on, f.deps)).phase, 'verified');
  assert.equal(inspect(target), true);
  assert.equal(inspect(target), true, 'later turns retain the same exact authorization');
  assert.equal(inspect(sourceId), false, 'receipt cannot authorize another native ID');
  assert.equal(inspect(target, { reasoningEffort: 'high' }), false);
  assert.equal(inspect(target, { nativeAccelerationSupported: false }), false);
  assert.equal(inspect(target, { botmuxSubagent: true }), false);
  assert.equal(inspect(target, { botmuxForwardOnly: true }), false);
  const receiptFile = nativeTargetReceiptFile(f.home, app, sid, target);
  const receipt = await readJson(receiptFile);
  for (const patch of [{ targetId: sourceId }, { targetModel: 'ferry-gpt-other' },
    { backendVariant: 'standard' }, { effort: 'high' }, { topicHash: '0'.repeat(64) },
    { authorized: false }, { state: 'failed' }, { sessionId: sourceId },
    { prefixBytes: 65 * 1024 * 1024 }]) {
    await atomicJson(receiptFile, { ...receipt, ...patch });
    assert.equal(inspect(target), false, JSON.stringify(patch));
  }
  await atomicJson(receiptFile, receipt);
  await chmod(receiptFile, 0o644);
  assert.equal(inspect(target), false);
  await chmod(receiptFile, 0o600);
  await writeFile(`${receiptFile}.elsewhere`, JSON.stringify(receipt), { mode: 0o600 });
  await rm(receiptFile);
  await symlink(`${receiptFile}.elsewhere`, receiptFile);
  assert.equal(inspect(target), false);
  await rm(receiptFile);
  await atomicJson(receiptFile, receipt);
  const controlFile = join(f.home, 'plugins/gateway-acceleration/private/topic-controls', app, `${sid}.json`);
  await atomicJson(controlFile, { disabled: true, reason: 'manual-cancel' });
  assert.equal(inspect(target), false, 'migration must not clear manual cancellation');
  await atomicJson(controlFile, {});
  f.config.liveControls = { bots: { [app]: { enabled: false, revision: 1 } } };
  await atomicJson(f.configFile, f.config);
  assert.equal(inspect(target), false, 'live OFF wins over the durable grant');
  f.config.liveControls.bots[app].enabled = true;
  await atomicJson(f.configFile, f.config);
  await atomicJson(join(f.home, 'bots.json'), [{ ...f.topic.bot, larkAppId: app, plugins: [] }]);
  assert.equal(inspect(target), false, 'removed host scope wins over the grant');
  assert.equal(await readFile(topicPath, 'utf8'), originalSnapshot);
});

test('matching gateway generation without an acceleration grant is not falsely marked converged', async t => {
  const f = await fixture(t);
  f.topic.scopeEnabled = false;
  f.topic.binding.acceleration = false;
  f.topic.runtime = f.runtime;
  await atomicJson(join(f.home, 'plugins/gateway-acceleration/private/topics', app, `${sid}.json`), f.topic);
  assert.equal((await f.run('gateway')).phase, 'switching');
  assert.equal(f.posts.length, 1, 'same-provider copy establishes a target-specific authorization');
});

test('Codex same-provider update parks only idle, warms without input and keeps native ID and history', async t => {
  const f = await fixture(t);
  f.topic.bot = { cliId: 'codex', model: choice.ferryModel, reasoningEffort: 'xhigh' };
  const selected = { ...choice, clientModel: choice.ferryModel, architecture: 'codex' };
  f.topic.binding = { architecture: 'codex', forwarding: true, acceleration: true, selection: selected, modelChoices: [selected] };
  const base = join(f.home, 'plugins/gateway-acceleration/private');
  await atomicJson(join(base, 'topics', app, `${sid}.json`), f.topic);
  await atomicJson(join(f.home, 'bots.json'), [{ ...f.topic.bot, larkAppId: app, plugins: ['gateway-acceleration'] }]);
  f.deps.env = { CODEX_HOME: join(f.home, 'native') };
  f.state.sameIdRuntimeRestartSupported = true;
  let now = 1000000;
  f.deps.now = () => now;
  const calls = [];
  f.deps.request = async (path, method, body) => {
    if (method !== 'POST') return structuredClone(f.state);
    calls.push({ path, body });
    if (path.endsWith('/park')) {
      Object.assign(f.state, { cold: true, workerReady: false, cliReady: false });
      return { state: 'parked' };
    }
    Object.assign(f.state, { cold: false, workerReady: true, cliReady: true });
    await atomicJson(join(base, 'runtime-launches', app, `${sid}.json`), {
      nativeSessionId: sourceId, startedAt: now, port: f.runtime.port,
      programHash: f.runtime.programHash, policyHash: f.runtime.policyHash,
    });
    return { state: 'warming' };
  };
  const on = await f.intent('gateway');
  f.state.busy = true;
  assert.equal((await reconcileTopicRouting(f.home, f.topic, on, f.deps)).phase, 'waiting');
  assert.equal(calls.length, 0);
  f.state.busy = false;
  assert.equal((await reconcileTopicRouting(f.home, f.topic, on, f.deps)).phase, 'switching');
  assert.deepEqual(calls, [{ path: `/api/sessions/${sid}/resume-target/park`, body: { sourceId } }]);
  now += 16000;
  assert.equal((await reconcileTopicRouting(f.home, f.topic, on, f.deps)).phase, 'switching');
  assert.deepEqual(calls[1], { path: `/api/sessions/${sid}/resume-target/prepare`, body: { sourceId } });
  assert.equal((await reconcileTopicRouting(f.home, f.topic, on, f.deps)).phase, 'verified');
  f.state.busy = true;
  assert.equal((await reconcileTopicRouting(f.home, f.topic, on, f.deps)).phase, 'verified',
    'normal later turns do not undo a completed runtime transition');
  assert.equal(await readFile(f.sourcePath, 'utf8'), f.source);
  assert.equal(f.state.nativeSessionId, sourceId);
  assert.equal((await f.run('native')).phase, 'blocked', 'same-provider support must not invent an OpenAI native equivalent');
  assert.equal(calls.length, 2);
});

test('OFF then ON copies from the actual latest history and preserves work done while native', async t => {
  const f = await fixture(t);
  const off = await f.intent('native');
  assert.equal((await reconcileTopicRouting(f.home, f.topic, off, f.deps)).phase, 'switching');
  assert.equal(f.posts.length, 1);
  assert.equal(await readFile(f.sourcePath, 'utf8'), f.source);
  const firstTarget = f.posts[0].targetId;
  f.state.nativeSessionId = firstTarget;
  assert.equal((await reconcileTopicRouting(f.home, f.topic, off, f.deps)).phase, 'verified');
  const nativePath = await historyFile(firstTarget, f.root);
  await writeFile(nativePath, await readFile(nativePath, 'utf8') + encode(turn('native-work', 'trae',
    choice.clientModel, 'max', 'work-done-after-off')));
  const on = await f.intent('gateway');
  assert.equal((await reconcileTopicRouting(f.home, f.topic, on, f.deps)).phase, 'switching');
  assert.equal(f.posts[1].sourceId, firstTarget, 'must not jump back to the pre-OFF original');
  const secondTarget = f.posts[1].targetId;
  const gatewayCopy = JSON.parse((await readFile(await historyFile(secondTarget, f.root), 'utf8')).split('\n')[1]);
  assert.ok(gatewayCopy.payload.items.some(item => item.content?.some(c => c.text === 'work-done-after-off')));
  f.state.nativeSessionId = secondTarget;
  assert.equal((await reconcileTopicRouting(f.home, f.topic, on, f.deps)).phase, 'verified');
  const receipt = await nativeTransitionHistory(f.home, app, sid, ['resume', secondTarget], f.deps.env, f.topic);
  assert.equal(receipt.provider, 'botmux_ferry');
  assert.equal(receipt.transitionRuntime.programHash, f.runtime.programHash);
  assert.equal((await nativeTransitionHistory(f.home, app, sid, ['resume', firstTarget], f.deps.env, f.topic)).provider, 'trae',
    'the previous target receipt survives a newer operation');
  assert.equal(await readFile(f.sourcePath, 'utf8'), f.source);
  assert.equal((await f.run('gateway')).phase, 'verified');
  assert.equal(f.posts.length, 2, 'repeated ON must not re-copy an already converged route');
});

test('same-provider runtime upgrades preserve encrypted reasoning instead of silently stripping it', async t => {
  const f = await fixture(t);
  const rows = f.source.trim().split('\n').map(JSON.parse);
  rows.find(r => r.type === 'history_mutation').payload.items.push({ type: 'reasoning', encrypted_content: 'same-provider-fixture' });
  await writeFile(f.sourcePath, encode(rows));
  assert.equal((await f.run('gateway')).phase, 'switching');
  const target = await historyFile(f.posts[0].targetId, f.root);
  const output = (await readFile(target, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(output[1].payload.items.find(i => i.type === 'reasoning').encrypted_content, 'same-provider-fixture');
});

test('busy or not-ready tasks never create a copy or request a restart', async t => {
  const f = await fixture(t);
  for (const patch of [{ busy: true }, { busy: false, workerReady: false }, { workerReady: true, cliReady: false }]) {
    Object.assign(f.state, patch);
    assert.equal((await f.run('native')).phase, 'waiting');
  }
  assert.equal(f.posts.length, 0);
  assert.equal(await readFile(f.sourcePath, 'utf8'), f.source);
});

test('dormant topics are warmed without a task before preparing any history replacement', async t => {
  const f = await fixture(t), intent = await f.intent('native');
  Object.assign(f.state, { cold: true, workerReady: false, cliReady: false, busy: true });
  const calls = [];
  f.deps.request = async (path, method, body) => {
    if (method !== 'POST') return structuredClone(f.state);
    calls.push({ path, body });
    if (path.endsWith('/prepare')) return { state: 'warming' };
    return { state: 'accepted', attemptId: 'owned' };
  };
  assert.equal((await reconcileTopicRouting(f.home, f.topic, intent, f.deps)).phase, 'waiting');
  assert.deepEqual(calls, [{ path: `/api/sessions/${sid}/resume-target/prepare`, body: { sourceId } }]);
  assert.equal((await reconcileTopicRouting(f.home, f.topic, intent, f.deps)).phase, 'waiting');
  assert.equal(calls.length, 1, 'a slow warm must not be repeated on every poll');
  Object.assign(f.state, { cold: false, workerReady: true, cliReady: true, busy: false });
  assert.equal((await reconcileTopicRouting(f.home, f.topic, intent, f.deps)).phase, 'switching');
  assert.equal(calls[1].path, `/api/sessions/${sid}/resume-target`);
  assert.equal(calls[1].body.sourceId, sourceId);
  assert.equal(Object.hasOwn(calls[1].body, 'prompt'), false);
});

test('a source changed after idle is recopied with its new work, rather than retrying a stale hash forever', async t => {
  const f = await fixture(t), intent = await f.intent('native');
  await reconcileTopicRouting(f.home, f.topic, intent, f.deps);
  const stale = f.posts[0];
  f.state.transition = { state: 'failed', targetId: stale.targetId, errorCode: 'native_resume_history_changed' };
  await writeFile(f.sourcePath, f.source + encode(turn('late', 'botmux_ferry', choice.ferryModel, 'standard', 'late-saved-work')));
  assert.equal((await reconcileTopicRouting(f.home, f.topic, intent, f.deps)).phase, 'switching');
  assert.notEqual(f.posts[1].targetId, stale.targetId);
  assert.notEqual(f.posts[1].sourceSha256, stale.sourceSha256);
  const newer = await readFile(await historyFile(f.posts[1].targetId, f.root), 'utf8');
  assert.ok(newer.includes('late-saved-work'));
});

test('an opposing switch arriving during restart converges only after the first target is ready', async t => {
  const f = await fixture(t), off = await f.intent('native');
  await reconcileTopicRouting(f.home, f.topic, off, f.deps);
  const on = await f.intent('gateway');
  f.state.workerReady = false;
  assert.equal((await reconcileTopicRouting(f.home, f.topic, on, f.deps)).phase, 'waiting');
  assert.equal(f.posts.length, 1);
  f.state.nativeSessionId = f.posts[0].targetId;
  f.state.workerReady = true;
  assert.equal((await reconcileTopicRouting(f.home, f.topic, on, f.deps)).phase, 'switching');
  assert.equal(f.posts[1].sourceId, f.posts[0].targetId);
});

test('a lost HTTP response reconciles the actual target without replaying the mutation', async t => {
  const f = await fixture(t), intent = await f.intent('native');
  f.deps.request = async (_path, method, body) => {
    if (method !== 'POST') return structuredClone(f.state);
    f.posts.push(body); f.state.nativeSessionId = body.targetId;
    throw new Error('connection lost after admission');
  };
  await reconcileTopicRouting(f.home, f.topic, intent, f.deps);
  assert.equal((await reconcileTopicRouting(f.home, f.topic, intent, f.deps)).phase, 'verified');
  assert.equal(f.posts.length, 1);
});

test('authority rotation and superseded revisions stop before physical side effects', async t => {
  const f = await fixture(t), old = await f.intent('native');
  await f.intent('gateway');
  assert.equal((await reconcileTopicRouting(f.home, f.topic, old, f.deps)).phase, 'superseded');
  const current = f.config.routingIntents.bots[app];
  await writeFile(join(f.home, '.dashboard-token'), 'rotated');
  assert.equal((await reconcileTopicRouting(f.home, f.topic, current, f.deps)).phase, 'blocked');
  assert.equal(f.posts.length, 0);
});

test('invalid target runtime bytes are caught before the original process could be retired', async t => {
  const f = await fixture(t);
  f.deps.copy = (...args) => {
    const result = createNativeHistory(...args);
    // Synchronous fixture fault occurs between copy preparation and the exact
    // launch-receipt validation; it never touches production runtime files.
    result.targetSha256 = '0'.repeat(64);
    return result;
  };
  assert.equal((await f.run('gateway')).phase, 'blocked');
  assert.equal(f.posts.length, 0);
  assert.equal(await readFile(f.sourcePath, 'utf8'), f.source);
});

test('unsupported clients are explicit and closed topics are never revived', async t => {
  const f = await fixture(t), intent = await f.intent('native');
  assert.equal((await reconcileTopicRouting(f.home, { ...f.topic, bot: { cliId: 'codex' } }, intent, f.deps)).phase, 'blocked');
  await reconcileRoutingTransitions(f.home, { ...f.deps,
    list: async () => ({ sessions: [{ sessionId: sid, larkAppId: app, status: 'closed' }] }) });
  assert.equal(f.posts.length, 0);
  const status = await readJson(join(f.home, 'plugins/gateway-acceleration/private/routing-status.json'));
  assert.equal(status.bots[app].counts.verified, 0);
  assert.equal(routingProjection(f.config, { bots: { [app]: { revision: 0, phase: 'verified' } } }, app).phase, 'pending');
});
