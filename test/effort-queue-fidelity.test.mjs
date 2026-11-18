import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { atomicJson } from '../shared/state.mjs';
import { createController, Controller, FerryRoute } from '../gateway/src/lib/runtime-policy.mjs';

test('enabled positive queue makes one native attempt without a probe result', () => {
  const turn = { botmuxAppId: 'cli_fixture', botmuxSessionId: '00000000-0000-4000-8000-000000000001' };
  const controller = new Controller(turn, { enabled: true, write() {} });
  assert.equal(controller.queue(0), undefined);
  assert.equal(controller.queue(NaN), undefined);
  assert.ok(controller.queue(2294, undefined) instanceof FerryRoute);
  assert.equal(controller.snapshot.alternative, undefined);
  controller.unavailable();
  assert.equal(controller.queue(2284, undefined), undefined);
});

test('disabled and already-generating requests never use missing-hint fallback', () => {
  const turn = { botmuxAppId: 'cli_fixture', botmuxSessionId: '00000000-0000-4000-8000-000000000001' };
  for (const options of [{ enabled: false }, { enabled: true, enabledNow: () => false }]) {
    assert.equal(new Controller(turn, { ...options, write() {} }).queue(2300), undefined);
  }
  const controller = new Controller(turn, { enabled: true, write() {} });
  controller.generatedOutput();
  assert.equal(controller.queue(2300), undefined);
});

test('memory/title requests do not overwrite main status; repeated native IDs cannot reclaim ownership', async t => {
  const home = await mkdtemp(join(tmpdir(), 'gateway-effort-fidelity-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const appId = 'cli_fidelity', sessionId = '00000000-0000-4000-8000-000000000081';
  const model = 'ferry-gpt-6-1-sol-max';
  const bot = { cliId: 'traex', model: 'GPT-6.1-Sol', modelBackendVariant: 'max', reasoningEffort: 'xhigh' };
  const binding = { architecture: 'traex', acceleration: true, selection: {
    clientModel: bot.model, ferryModel: model, backendVariant: 'max',
    efforts: ['medium', 'xhigh'], accelerationAvailable: true } };
  await atomicJson(join(home, 'bots.json'), [{ ...bot, larkAppId: appId, plugins: ['gateway-acceleration'] }]);
  await atomicJson(join(home, 'plugins-registry.json'), { plugins: { 'gateway-acceleration': {} } });
  await atomicJson(join(home, 'plugins/gateway-acceleration/config.json'), { controlPlane: { bots: { [appId]: binding } } });
  await atomicJson(join(home, 'plugins/gateway-acceleration/private/topics', appId, `${sessionId}.json`),
    { schemaVersion: 1, appId, sessionId, bot, binding, scopeEnabled: true });
  const turn = { botmuxAppId: appId, botmuxSessionId: sessionId, requestId: 'native-shared-id',
    model: { codexId: model }, botmuxRequestedModel: model, reasoningEffort: 'xhigh',
    nativeAccelerationSupported: true, signal: new AbortController().signal };
  const main = createController(turn, { home });
  main.queue(1000);
  const path = join(home, 'plugins/gateway-acceleration/private/requests', appId, `${sessionId}.json`);
  const first = await readFile(path, 'utf8');
  const title = createController({ ...turn, reasoningEffort: 'medium' }, { home });
  title.queue(2000); title.finish();
  const memory = createController({ ...turn, botmuxSubagent: true, reasoningEffort: 'medium' }, { home });
  memory.queue(3000); memory.finish();
  const sameEffortSubagent = createController({ ...turn, botmuxSubagent: true }, { home });
  sameEffortSubagent.queue(4000);
  assert.equal(await readFile(path, 'utf8'), first);
  assert.equal(main.canAccelerate(), true);
  assert.equal(title.canAccelerate(), false);
  assert.equal(memory.canAccelerate(), false);
  const next = createController(turn, { home });
  next.queue(10);
  const nextSnapshot = await readFile(path, 'utf8');
  main.finish(new Error('old main disconnected'));
  assert.equal(await readFile(path, 'utf8'), nextSnapshot);
  assert.equal(JSON.parse(nextSnapshot).reasoningEffort, 'xhigh');
});
