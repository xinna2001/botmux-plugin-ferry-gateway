import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { digest, readJson } from '../shared/state.mjs';
import { controlStatus, setControl } from '../gateway/src/lib/control-plane.mjs';
import { saveSettings } from '../gateway/src/server/settings.mjs';

const models = [
  { name: 'GPT-6.1-Sol', codex: 'ferry-gpt-6-1-sol', trae: 'gpt-6.1-sol__dev', context: 475000, efforts: ['medium', 'xhigh'], acceleration_supported: true },
  { name: 'GPT-6.1-Sol Max', codex: 'ferry-gpt-6-1-sol-max', trae: 'gpt-6.1-sol__max', context: 1000000, efforts: ['medium', 'xhigh'], acceleration_supported: true },
];
const native = { models: ['GPT-6.1-Sol'], modelCapabilities: [{ slug: 'GPT-6.1-Sol', contextVariants: [
  { id: 'standard', contextWindow: 475000, reasoningEfforts: ['medium', 'xhigh'] },
  { id: 'max', contextWindow: 800000, reasoningEfforts: ['medium', 'xhigh'] },
] }] };

async function fixture(callback) {
  const home = await mkdtemp(join(tmpdir(), 'ferry-control-plane-'));
  const configFile = join(home, 'plugins/gateway-acceleration/config.json');
  await mkdir(join(home, 'plugins/gateway-acceleration'), { recursive: true });
  const bots = [
    { larkAppId: 'cli_codex_fixture', cliId: 'codex', model: models[0].codex, reasoningEffort: 'xhigh', plugins: ['gateway-acceleration'], larkAppSecret: 'fixture-only-secret' },
    { larkAppId: 'cli_traex_fixture', cliId: 'traex', model: 'GPT-6.1-Sol', modelBackendVariant: 'standard', reasoningEffort: 'xhigh', plugins: ['gateway-acceleration'] },
  ];
  await writeFile(join(home, 'bots.json'), JSON.stringify(bots));
  await writeFile(join(home, 'config.json'), '{}');
  await writeFile(join(home, '.dashboard-token'), 'fixture-authority');
  await writeFile(join(home, 'plugins-registry.json'), '{"plugins":{"gateway-acceleration":{}}}');
  await writeFile(configFile, '{"preserve":"existing settings"}');
  const reloads = [];
  const deps = {
    gatewayModels: async () => models,
    managedRuntimeStatus: async () => ({ online: true, ready: true, port: 18790, pid: 1234 }),
    nativeModelCatalog: async () => native,
    request: async () => ({ bots: [] }),
    prepareClientCatalog: async () => join(home, 'models.json'),
    prepareClientBinding: async bot => {
      const launcher = join(home, `${bot.larkAppId}.sh`);
      const source = '#!/bin/sh\nexit 0\n';
      await writeFile(launcher, source, { mode: 0o700 });
      return { bindingId: 'fixture', architecture: bot.cliId, launcher, launcherHash: digest(source),
        native: { command: process.execPath, prefixArgs: [], version: 'fixture' } };
    },
    reloadBot: async (_home, bot) => { reloads.push(structuredClone(bot)); return { ok: true }; },
  };
  const profile = async architecture => (await controlStatus(home, deps)).profiles.find(value => value.cliId === architecture);
  const choose = async (architecture, modelId = models[0].codex) => {
    // Simulate a user choosing in the HOST Bot settings. The plugin is only
    // asked to toggle its route and must preserve that already-selected model.
    const row = await profile(architecture);
    const choice = row.modelChoices.find(value => value.id === modelId);
    assert.ok(choice, 'fixture requires a supported host model');
    const saved = await readJson(join(home, 'bots.json'));
    const bot = saved.find(value => value.cliId === architecture);
    const patch = { model: choice.clientModel, ...(architecture === 'traex' ? { modelBackendVariant: choice.backendVariant } : {}) };
    if (Object.entries(patch).some(([key, value]) => bot[key] !== value)) {
      Object.assign(bot, patch);
      await writeFile(join(home, 'bots.json'), JSON.stringify(saved));
    }
    await toggle(architecture, architecture === 'codex' ? 'forwarding' : 'acceleration', true);
    if (architecture === 'traex') await toggle(architecture, 'acceleration', false);
    return controlStatus(home, deps);
  };
  const toggle = async (architecture, action, enabled) => {
    const row = await profile(architecture);
    return setControl({ profileId: row.id, revision: row.revision, action, enabled }, home, deps);
  };
  try { await callback({ home, bots, configFile, deps, reloads, profile, choose, toggle }); }
  finally { await rm(home, { recursive: true, force: true }); }
}

test('status discovers actual architectures and never exposes Bot secrets', () => fixture(async context => {
  const status = await controlStatus(context.home, context.deps);
  assert.deepEqual(status.profiles.map(profile => profile.cliId), ['codex', 'traex']);
  assert.ok(status.profiles.every(profile => profile.modelChoices.length === 2));
  assert.ok(!JSON.stringify(status).includes('fixture-only-secret'));
  assert.deepEqual(status.profiles.map(profile => profile.controlAvailable), [true, true]);
}));

test('unconfigured daily profiles remain available while the managed runtime is offline', () => fixture(async context => {
  context.deps.managedRuntimeStatus = async () => ({ online: false });
  const before = await readFile(join(context.home, 'bots.json'), 'utf8');
  const status = await controlStatus(context.home, context.deps);
  assert.equal(status.profiles.length, 2);
  for (const profile of status.profiles) {
    assert.equal(profile.controlMode, 'unconfigured');
    assert.equal(profile.controlRuntimeOnline, false);
    assert.equal(profile.health.state, 'unconfigured');
    assert.equal(profile.controlAvailable, false);
    assert.equal(profile.connection.enabled, false);
  }
  await assert.rejects(context.choose('codex'), /环境准备完成/);
  assert.equal(await readFile(join(context.home, 'bots.json'), 'utf8'), before);
}));

test('legacy status separates enabled state from permission to control a coupled flag', () => fixture(async context => {
  await writeFile(context.configFile, JSON.stringify({
    profiles: [{ id: 'legacy-codex', appId: context.bots[0].larkAppId },
      { id: 'legacy-traex', appId: context.bots[1].larkAppId }],
  }));
  context.deps.managedRuntimeStatus = async () => ({ online: false });
  context.deps.legacyStatus = async () => ({ profiles: context.bots.map(bot => ({
    appId: bot.larkAppId, health: { online: true, version: '0.2.3-fixture' }, enabled: true,
    controlAvailable: bot.cliId === 'codex', connection: { enabled: true, verified: true },
    compatibility: { eligible: true, reason: 'fixture independent control' },
    requests: [{ session: 'must-not-leak' }],
  })) });
  const before = await readFile(context.configFile, 'utf8');
  const status = await controlStatus(context.home, context.deps);
  assert.equal(status.profiles[0].enabled, true);
  assert.equal(status.profiles[1].enabled, true);
  for (const profile of status.profiles) {
    assert.equal(profile.controlMode, profile.cliId === 'codex' ? 'legacy-independent' : 'legacy-readonly');
    assert.equal(profile.health.online, true);
    assert.equal(profile.controlRuntimeOnline, false);
    assert.equal(profile.controlAvailable, profile.cliId === 'codex');
    assert.equal(profile.health.version, '0.2.3-fixture');
    assert.equal(profile.connection.controlAvailable, false);
    assert.equal(profile.connection.enabled, true);
    assert.deepEqual(profile.requests, []);
  }
  await context.toggle('traex', 'acceleration', false);
  assert.equal((await readJson(context.configFile)).topicDefaults.scopes[context.bots[1].larkAppId], false);
  assert.deepEqual((await readJson(context.configFile)).profiles, JSON.parse(before).profiles);
}));

test('legacy status failures stay unknown and never hide the daily profiles', () => fixture(async context => {
  await writeFile(context.configFile, JSON.stringify({ profiles: [{ id: 'legacy-codex', appId: context.bots[0].larkAppId }] }));
  context.deps.legacyStatus = async () => { throw new Error('unavailable fixture'); };
  const row = await context.profile('codex');
  assert.equal(row.controlMode, 'legacy-readonly');
  assert.equal(row.health.state, 'unknown');
  assert.equal(row.controlAvailable, false);
  assert.equal(row.enabled, null);
  assert.match(row.compatibility.reason, /暂不可核验/);
}));

test('an unverified legacy route is unknown rather than displayed as acceleration off', () => fixture(async context => {
  await writeFile(context.configFile, JSON.stringify({ profiles: [{ id: 'legacy-traex', appId: context.bots[1].larkAppId }] }));
  context.deps.legacyStatus = async () => ({ profiles: [{
    appId: context.bots[1].larkAppId, health: { online: true }, enabled: true,
    controlAvailable: false, connection: { enabled: true, verified: false },
  }] });
  assert.equal((await context.profile('traex')).enabled, null);
}));

test('new model adoption uses the managed runtime health rather than an offline legacy route', () => fixture(async context => {
  await writeFile(context.configFile, JSON.stringify({ profiles: [{ id: 'legacy-codex', appId: context.bots[0].larkAppId }] }));
  context.deps.legacyStatus = async () => ({ profiles: [{
    appId: context.bots[0].larkAppId, health: { online: false }, controlAvailable: false, connection: {},
  }] });
  await context.choose('codex');
  const row = await context.profile('codex');
  assert.equal(row.controlMode, 'managed');
  assert.equal(row.health.online, true);
  assert.equal(row.connection.enabled, true);
}));

test('Codex forwarding binds the already-selected host model and keeps acceleration independent', () => fixture(async context => {
  await context.choose('codex');
  const saved = await readJson(join(context.home, 'bots.json'));
  assert.equal(saved[0].model, models[0].codex);
  assert.match(saved[0].cliPathOverride, /cli_codex_fixture/);
  assert.equal(saved[0].larkAppSecret, context.bots[0].larkAppSecret);
  assert.deepEqual(saved[1], context.bots[1]);
  assert.equal(context.reloads.length, 1);
  let row = await context.profile('codex');
  assert.equal(row.connection.enabled, true);
  assert.equal(row.enabled, false);
  await context.toggle('codex', 'acceleration', true);
  await context.toggle('codex', 'forwarding', false);
  assert.equal((await context.profile('codex')).enabled, false);
  assert.equal((await context.profile('codex')).connection.enabled, false);
  await assert.rejects(context.toggle('codex', 'acceleration', true), /先开启模型转发/);
  await context.toggle('codex', 'forwarding', true);
  row = await context.profile('codex');
  assert.equal(row.connection.enabled, true);
  assert.equal((await readJson(join(context.home, 'bots.json')))[0].model, models[0].codex);
  await context.toggle('codex', 'forwarding', false);
  assert.equal((await context.profile('codex')).connection.enabled, false);
}));

test('TraeX routing preserves the host native model and Max variant, not a Codex model ID', () => fixture(async context => {
  await context.choose('traex', models[1].codex);
  const saved = await readJson(join(context.home, 'bots.json'));
  assert.equal(saved[1].model, 'GPT-6.1-Sol');
  assert.equal(saved[1].modelBackendVariant, 'max');
  assert.equal(saved[1].reasoningEffort, 'xhigh');
  assert.deepEqual(saved[0], context.bots[0]);
  assert.equal((await context.profile('traex')).connection.controlAvailable, false);
  await context.toggle('traex', 'acceleration', true);
  assert.equal((await context.profile('traex')).enabled, true);
  await assert.rejects(context.toggle('traex', 'forwarding', true), /不提供/);
  assert.equal((await readJson(join(context.home, 'bots.json')))[1].modelBackendVariant, 'max');
}));

test('removed model API and stale route revisions cannot change the host configuration', () => fixture(async context => {
  const before = await readFile(join(context.home, 'bots.json'), 'utf8');
  const result = await saveSettings(null, { action: 'model', modelId: models[0].codex });
  assert.equal(result.ok, false);
  const row = await context.profile('codex');
  await assert.rejects(setControl({ profileId: row.id, revision: 'old', action: 'forwarding', enabled: true },
    context.home, context.deps), /配置或模型目录已变化/);
  assert.equal(await readFile(join(context.home, 'bots.json'), 'utf8'), before);
  assert.equal((await readJson(context.configFile)).preserve, 'existing settings');
}));

test('after a host change to non-GPT or auto, enable is blocked but existing routes can still be turned off', () => fixture(async context => {
  await context.toggle('codex', 'forwarding', true);
  await context.toggle('codex', 'acceleration', true);
  const saved = await readJson(join(context.home, 'bots.json'));
  saved[0].model = 'claude-fixture';
  await writeFile(join(context.home, 'bots.json'), JSON.stringify(saved));
  assert.equal((await context.profile('codex')).canEnableForwarding, false);
  assert.equal((await context.profile('codex')).canEnableAcceleration, false);
  await assert.rejects(context.toggle('codex', 'forwarding', true), /同模型映射/);
  await context.toggle('codex', 'forwarding', false);
  const row = await context.profile('codex');
  assert.equal(row.connection.controlAvailable, false);
  assert.equal(row.enabled, false);
  saved[0].model = models[0].codex;
  saved[0].traexAutoModel = { enabled: true };
  await writeFile(join(context.home, 'bots.json'), JSON.stringify(saved));
  assert.equal((await context.profile('codex')).canEnableForwarding, false);
  await assert.rejects(context.toggle('codex', 'forwarding', true), /自动选模/);
}));

test('an online but unauthenticated daemon cannot enable either control', () => fixture(async context => {
  context.deps.managedRuntimeStatus = async () => ({ online: true, ready: false, authenticated: false, port: 18790, pid: 1234 });
  for (const cli of ['codex', 'traex']) {
    const row = await context.profile(cli);
    assert.equal(row.canEnableForwarding, false);
    assert.equal(row.canEnableAcceleration, false);
    await assert.rejects(context.toggle(cli, cli === 'codex' ? 'forwarding' : 'acceleration', true), /环境准备完成/);
  }
}));

test('a failed host reload rolls back owned fields without overwriting another Bot edit', () => fixture(async context => {
  const before = await readJson(context.configFile);
  context.deps.reloadBot = async () => {
    const bots = await readJson(join(context.home, 'bots.json'));
    bots[1].displayMarker = 'concurrent change';
    await writeFile(join(context.home, 'bots.json'), JSON.stringify(bots));
    throw new Error('host unavailable');
  };
  await assert.rejects(context.choose('codex'), /host unavailable/);
  const bots = await readJson(join(context.home, 'bots.json'));
  assert.deepEqual(bots[0], context.bots[0]);
  assert.equal(bots[1].displayMarker, 'concurrent change');
  assert.deepEqual(await readJson(context.configFile), before);
}));

test('scope disable rejects activation but still permits turning an existing control off', () => fixture(async context => {
  await context.choose('codex');
  await context.toggle('codex', 'acceleration', true);
  const bots = await readJson(join(context.home, 'bots.json'));
  bots[0].plugins = [];
  await writeFile(join(context.home, 'bots.json'), JSON.stringify(bots));
  await assert.rejects(context.toggle('codex', 'acceleration', true), /插件范围/);
  await context.toggle('codex', 'acceleration', false);
  assert.equal((await context.profile('codex')).enabled, false);
}));

test('authority rotation during client preparation cannot change a Bot', () => fixture(async context => {
  const before = await readFile(join(context.home, 'bots.json'), 'utf8');
  const prepare = context.deps.prepareClientBinding;
  context.deps.prepareClientBinding = async (...args) => {
    const binding = await prepare(...args);
    await writeFile(join(context.home, '.dashboard-token'), 'rotated-authority');
    return binding;
  };
  await assert.rejects(context.choose('codex'), /管理身份已变化/);
  assert.equal(await readFile(join(context.home, 'bots.json'), 'utf8'), before);
}));

test('a fresh TraeX Bot binds from host settings when its acceleration switch is first enabled', () => fixture(async context => {
  const before = await readJson(join(context.home, 'bots.json'));
  await context.toggle('traex', 'acceleration', true);
  const profile = await context.profile('traex');
  assert.equal(profile.adopted, true);
  assert.equal(profile.enabled, true);
  const after = await readJson(join(context.home, 'bots.json'));
  for (const field of ['model', 'reasoningEffort', 'modelBackendVariant']) assert.equal(after[1][field], before[1][field]);
  assert.deepEqual(after[0], before[0]);
  await context.toggle('traex', 'acceleration', false);
  assert.equal((await context.profile('traex')).enabled, false);
}));

test('a fresh Codex route requires a separate host scope transaction and never rewrites its selected model', () => fixture(async context => {
  const bots = await readJson(join(context.home, 'bots.json'));
  bots[0].model = models[0].codex;
  bots[0].plugins = ['unrelated-plugin'];
  await writeFile(join(context.home, 'bots.json'), JSON.stringify(bots));
  const before = await readJson(join(context.home, 'bots.json'));
  context.deps.enableBotScope = async (home, appId) => {
    const saved = await readJson(join(home, 'bots.json'));
    const bot = saved.find(bot => bot.larkAppId === appId);
    bot.plugins = [...bot.plugins, 'gateway-acceleration'];
    await writeFile(join(home, 'bots.json'), JSON.stringify(saved));
  };
  await assert.rejects(context.toggle('codex', 'acceleration', true), /插件范围/);
  await assert.rejects(context.toggle('codex', 'forwarding', true), /插件范围/);
  assert.deepEqual(await readJson(join(context.home, 'bots.json')), before);
  await context.deps.enableBotScope(context.home, bots[0].larkAppId);
  await assert.rejects(context.toggle('codex', 'acceleration', true), /先开启模型转发/);
  await context.toggle('codex', 'forwarding', true);
  let profile = await context.profile('codex');
  assert.equal(profile.adopted, true);
  assert.equal(profile.connection.enabled, true);
  assert.equal(profile.enabled, false);
  await context.toggle('codex', 'acceleration', true);
  await context.toggle('codex', 'forwarding', false);
  profile = await context.profile('codex');
  assert.equal(profile.connection.enabled, false);
  assert.equal(profile.enabled, false);
  const after = await readJson(join(context.home, 'bots.json'));
  assert.equal(after[0].model, before[0].model);
  assert.deepEqual(after[0].plugins, ['unrelated-plugin', 'gateway-acceleration']);
  assert.deepEqual(after[1], before[1]);
  await context.toggle('codex', 'forwarding', true);
  assert.equal((await context.profile('codex')).enabled, false);
}));
