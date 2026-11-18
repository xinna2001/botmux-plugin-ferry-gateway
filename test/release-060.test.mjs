import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { atomicJson, readJson, digest } from '../shared/state.mjs';
import { topicSnapshot, publicBot, readTopic, topicFile } from '../gateway/src/lib/topic-state.mjs';
import { createController } from '../gateway/src/lib/runtime-policy.mjs';
import { controlStatus, setDefaultScope } from '../gateway/src/lib/control-plane.mjs';
import { cachedPreparationStatus, invalidatePreparation } from '../gateway/src/lib/preparation-cache.mjs';
import { checkAndUpdate, compareVersion } from '../gateway/src/lib/update.mjs';

const appId = 'cli_topic_fixture', sessionId = '00000000-0000-4000-8000-000000000601';
const selection = { ferryModel: 'ferry-gpt-6-1-sol', clientModel: 'ferry-gpt-6-1-sol',
  efforts: ['xhigh'], contextWindow: 475000, accelerationAvailable: true };
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'gateway-060-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const bot = { larkAppId: appId, cliId: 'codex', model: selection.clientModel,
    reasoningEffort: 'xhigh', plugins: ['gateway-acceleration'], larkAppSecret: 'must-not-persist' };
  const launcher = join(home, 'launch');
  await writeFile(launcher, '#!/bin/sh\nexit 0\n');
  bot.cliPathOverride = launcher;
  const binding = { bindingId: 'fixture', architecture: 'codex', launcher,
    launcherHash: digest('#!/bin/sh\nexit 0\n'), selection, forwarding: true, acceleration: true,
    native: { command: process.execPath, prefixArgs: [] } };
  await atomicJson(join(home, 'bots.json'), [bot]);
  await writeFile(join(home, '.dashboard-token'), 'fixture-authority');
  await atomicJson(join(home, 'plugins-registry.json'), { plugins: { 'gateway-acceleration': {} } });
  const configFile = join(home, 'plugins/gateway-acceleration/config.json');
  await atomicJson(configFile, { preserve: 1, controlPlane: { schemaVersion: 1, bots: { [appId]: binding } } });
  const deps = {
    request: async () => ({ bots: [] }),
    managedRuntimeStatus: async () => ({ online: true, ready: true, authenticated: true, catalogReady: true,
      authExpiresAt: new Date(Date.now() + 3600000).toISOString(), dependencies: { ready: true }, port: 19060, pid: 60 }),
    gatewayModels: async () => [{ name: 'GPT-6.1-Sol', codex: selection.ferryModel,
      context: 475000, efforts: ['xhigh'], acceleration_supported: true }],
    nativeModelCatalog: async () => ({ models: ['gpt-6.1-sol'], reasoningEffortsByModel: { 'gpt-6.1-sol': ['xhigh'] } }),
    prepareClientCatalog: async () => join(home, 'catalog.json'),
    runtimeStatus: async () => ({ ready: true, version: 'v24.16.0' }),
    detectFerry: async () => ({ version: '0.1.98' }),
    setupStatus: async () => ({ installed: true, adapterCompatible: true, authenticated: true, version: '0.1.98' }),
    reloadBot: async () => { throw new Error('must not reload existing binding'); },
  };
  // Native and Ferry names may be equal in this fixture, as permitted by the catalog.
  deps.nativeModelCatalog = async () => ({ models: [selection.clientModel],
    reasoningEffortsByModel: { [selection.clientModel]: ['xhigh'] } });
  return { home, bot, binding, configFile, deps };
}
function snapshot(bot, binding, enabled) {
  return { schemaVersion: 1, appId, sessionId, bot: publicBot(bot), binding, scopeEnabled: enabled, createdAt: Date.now() };
}
const turn = () => ({ botmuxAppId: appId, botmuxSessionId: sessionId, requestId: 'request',
  model: { codexId: selection.ferryModel }, botmuxRequestedModel: selection.ferryModel,
  reasoningEffort: 'xhigh', nativeAccelerationSupported: true, signal: new AbortController().signal });

for (const initial of [false, true]) test(`topic policy ${initial} survives defaults, scope, model and management changes`, async t => {
  const { home, bot, binding, configFile } = await fixture(t);
  await topicSnapshot(home, appId, sessionId, async () => snapshot(bot, binding, initial));
  assert.equal(createController(turn(), { home, write() {} }).canAccelerate(), initial);
  await atomicJson(configFile, { topicDefaults: { scopes: { [appId]: !initial } } });
  await atomicJson(join(home, 'bots.json'), [{ ...bot, model: 'changed', plugins: [], reasoningEffort: 'low' }]);
  await atomicJson(join(home, 'plugins-registry.json'), { plugins: {} });
  assert.equal(createController({ ...turn(), requestId: 'next' }, { home, write() {} }).canAccelerate(), initial);
  const saved = await topicSnapshot(home, appId, sessionId, async () => { throw new Error('must not reinitialize'); });
  assert.equal(saved.scopeEnabled, initial);
  assert.ok(!JSON.stringify(saved).includes('must-not-persist'));
});
test('malformed identity fails closed instead of recapturing changed defaults', async t => {
  const { home } = await fixture(t);
  assert.throws(() => topicFile(home, '../other', sessionId));
  assert.throws(() => topicFile(home, appId, '../../bad'));
  await atomicJson(topicFile(home, appId, sessionId), { schemaVersion: 1, appId: 'other' });
  assert.throws(() => readTopic(home, appId, sessionId), /快照无效/);
});
test('Codex master couples both defaults and does not mutate existing route or host scope', async t => {
  const { home, bot, binding, configFile, deps } = await fixture(t);
  const botsBefore = await readFile(join(home, 'bots.json'), 'utf8');
  for (const enabled of [false, true, false, true]) {
    const value = await setDefaultScope({ appId, enabled }, home, deps);
    const config = await readJson(configFile);
    assert.deepEqual(config.controlPlane.bots[appId], binding);
    assert.equal(config.topicDefaults.bindings[appId].forwarding, enabled);
    assert.equal(config.topicDefaults.bindings[appId].acceleration, enabled);
    assert.equal(config.topicDefaults.scopes[appId], enabled);
    assert.equal(value.profiles[0].pluginEnabled, enabled);
    assert.equal(value.profiles[0].enabled, enabled);
    assert.equal(value.profiles[0].connection.enabled, enabled);
    assert.equal(await readFile(join(home, 'bots.json'), 'utf8'), botsBefore);
  }
});
test('global off also clears individual new-topic defaults while keeping old routing', async t => {
  const { home, binding, configFile, deps } = await fixture(t);
  await setDefaultScope({ appId: 'global', enabled: true }, home, deps);
  await setDefaultScope({ appId: 'global', enabled: false }, home, deps);
  const config = await readJson(configFile);
  assert.equal(config.topicDefaults.globalEnabled, false);
  assert.equal(config.topicDefaults.scopes[appId], false);
  assert.deepEqual(config.controlPlane.bots[appId], binding);
});
test('failed activation and stale authority cannot alter new-topic settings', async t => {
  const { home, configFile, deps } = await fixture(t);
  deps.managedRuntimeStatus = async () => ({ online: false });
  const before = await readFile(configFile, 'utf8');
  await assert.rejects(setDefaultScope({ appId, enabled: true }, home, deps), /尚未核验/);
  assert.equal(await readFile(configFile, 'utf8'), before);
  await rm(join(home, '.dashboard-token'));
  await assert.rejects(setDefaultScope({ appId, enabled: false }, home, deps));
  assert.equal(await readFile(configFile, 'utf8'), before);
});
test('durable installation cache survives module callers; repeated reads do not rescan', async t => {
  const { home, deps } = await fixture(t);
  let calls = 0;
  deps.setupStatus = async () => { calls++; return { installed: true, adapterCompatible: true, version: '0.1.98',
    authenticated: true, authExpiresAt: new Date(Date.now() + 3600000).toISOString() }; };
  const runtime = await deps.managedRuntimeStatus();
  await cachedPreparationStatus(home, deps, runtime);
  for (let i = 0; i < 12; i++) assert.equal((await cachedPreparationStatus(home, { ...deps }, runtime)).cached, true);
  assert.equal(calls, 1);
  const cache = await readJson(join(home, 'plugins/gateway-acceleration/private/preparation-cache.json'));
  assert.ok(!JSON.stringify(cache).includes('must-not-persist'));
  await invalidatePreparation(home);
  await cachedPreparationStatus(home, deps, runtime);
  assert.equal(calls, 2);
});
test('serving login expiration overrides cached login without repeating install discovery', async t => {
  const { home, deps } = await fixture(t);
  let calls = 0;
  deps.setupStatus = async () => { calls++; return { installed: true, adapterCompatible: true,
    version: '0.1.98', authenticated: true }; };
  await cachedPreparationStatus(home, deps, await deps.managedRuntimeStatus());
  const expired = await cachedPreparationStatus(home, deps, { online: true, ready: false, authenticated: false });
  assert.equal(expired.authenticated, false);
  assert.equal(expired.ready, false);
  assert.equal(calls, 1);
});
test('failed detection is not cached as a confirmed missing installation', async t => {
  const { home, deps } = await fixture(t);
  deps.setupStatus = async () => { throw new Error('inspection failed'); };
  await assert.rejects(cachedPreparationStatus(home, deps), /inspection failed/);
  assert.equal(await readJson(join(home, 'plugins/gateway-acceleration/private/preparation-cache.json'), null), null);
});
test('semantic version comparison does not use lexical version ordering', () => {
  assert.equal(compareVersion('0.1.120', '0.1.98'), 1);
  assert.equal(compareVersion('0.1.98', '0.1.120'), -1);
  assert.equal(compareVersion('0.1.98', '0.1.98'), 0);
  assert.throws(() => compareVersion('../bad', '0.1.98'));
});
for (const currentVersion of ['0.1.98', '0.1.120']) test(`up-to-date check ${currentVersion} never installs, downgrades, or restarts`, async t => {
  const { home } = await fixture(t);
  const calls = [], job = {};
  const result = await checkAndUpdate(home, { detectFerry: async () => ({ version: currentVersion }),
    run: async (_cmd, args) => { calls.push(args); return { stdout: JSON.stringify({ version: '0.1.98',
      'dist.integrity': `sha512-${'a'.repeat(86)}==` }) }; } }, job);
  assert.equal(result.updated, false);
  assert.equal(calls.length, 1);
  assert.match(job.progress, /已是最新版/);
});
test('unverified latest release is blocked before downloading; old pointers remain unchanged', async t => {
  const { home } = await fixture(t);
  const file = join(home, 'plugins/gateway-acceleration/private/runtime/prepared.json');
  await atomicJson(file, { port: 12345, program: 'old' });
  let calls = 0;
  await assert.rejects(checkAndUpdate(home, { detectFerry: async () => ({ version: '0.1.98' }),
    run: async () => { calls++; return { stdout: JSON.stringify({ version: '0.1.121',
      'dist.integrity': `sha512-${'a'.repeat(86)}==` }) }; } }), /尚未通过.*保留原版本/);
  assert.equal(calls, 1);
  assert.deepEqual(await readJson(file), { port: 12345, program: 'old' });
});
test('a registry integrity error cannot reach installation', async t => {
  const { home } = await fixture(t);
  await assert.rejects(checkAndUpdate(home, { detectFerry: async () => null,
    run: async () => ({ stdout: JSON.stringify({ version: '0.1.98', 'dist.integrity': 'bad' }) }) }), /完整性无法核验/);
});
