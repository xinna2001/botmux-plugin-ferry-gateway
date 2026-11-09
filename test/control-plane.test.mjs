import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { digest, readJson } from '../shared/state.mjs';
import { controlStatus, selectControlModel, setControl } from '../gateway/src/lib/control-plane.mjs';

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
    { larkAppId: 'cli_codex_fixture', cliId: 'codex', model: 'native-old', reasoningEffort: 'xhigh', plugins: ['gateway-acceleration'], larkAppSecret: 'fixture-only-secret' },
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
    managedRuntimeStatus: async () => ({ online: true, port: 18790, pid: 1234 }),
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
    const row = await profile(architecture);
    return selectControlModel({ profileId: row.id, revision: row.revision, modelId }, home, deps);
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
  assert.ok(status.profiles.every(profile => !profile.controlAvailable));
}));

test('Codex selection applies the actual model and managed launcher, then acceleration remains independent', () => fixture(async context => {
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
  await assert.rejects(context.toggle('codex', 'forwarding', false), /先关闭同模型加速/);
  await context.toggle('codex', 'acceleration', false);
  row = await context.profile('codex');
  assert.equal(row.connection.enabled, true);
  assert.equal((await readJson(join(context.home, 'bots.json')))[0].model, models[0].codex);
  await context.toggle('codex', 'forwarding', false);
  assert.equal((await context.profile('codex')).connection.enabled, false);
}));

test('TraeX selection writes its native model and Max variant, not a Codex model ID', () => fixture(async context => {
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
  await assert.rejects(context.choose('traex'), /先关闭同模型加速/);
}));

test('forged non-GPT selections and stale revisions leave configuration unchanged', () => fixture(async context => {
  const before = await readFile(join(context.home, 'bots.json'), 'utf8');
  await assert.rejects(context.choose('codex', 'claude-unrelated'), /固定 GPT/);
  const row = await context.profile('codex');
  await assert.rejects(selectControlModel({ profileId: row.id, revision: 'old', modelId: models[0].codex },
    context.home, context.deps), /配置或模型目录已变化/);
  assert.equal(await readFile(join(context.home, 'bots.json'), 'utf8'), before);
  assert.equal((await readJson(context.configFile)).preserve, 'existing settings');
}));

test('a failed host reload rolls back owned fields without overwriting another Bot edit', () => fixture(async context => {
  const before = await readJson(context.configFile);
  context.deps.reloadBot = async () => {
    const bots = await readJson(join(context.home, 'bots.json'));
    bots[1].displayMarker = 'concurrent change';
    await writeFile(join(context.home, 'bots.json'), JSON.stringify(bots));
    throw new Error('host unavailable');
  };
  await assert.rejects(context.choose('codex'), /内存状态尚未确认/);
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
  await assert.rejects(context.toggle('codex', 'acceleration', true), /启用插件/);
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
