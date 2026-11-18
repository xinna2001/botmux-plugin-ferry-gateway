import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { atomicJson, digest, readJson } from '../shared/state.mjs';
import { prepareLegacyBridge, applyLegacyBridge, restoreLegacyBridge } from '../gateway/src/lib/legacy-bridge.mjs';
import { controlStatus, setControl } from '../gateway/src/lib/control-plane.mjs';
import { controlLaunchPlan } from '../gateway/src/lib/control-launcher.mjs';

async function fixture(context) {
  const home = await mkdtemp(join(tmpdir(), 'ferry-legacy-bridge-'));
  context.after(() => rm(home, { recursive: true, force: true }));
  const originalPath = join(home, 'old-launcher');
  const original = '#!/bin/sh\nexit 0\n';
  await writeFile(originalPath, original, { mode: 0o700 });
  const launcher = join(home, 'private', 'launch');
  await mkdir(join(home, 'private'));
  await writeFile(launcher, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const bot = { larkAppId: 'cli_arbitrary_owner', cliId: 'traex', model: 'GPT-6.1-Sol',
    modelBackendVariant: 'max', reasoningEffort: 'xhigh', cliPathOverride: originalPath, plugins: ['gateway-acceleration'] };
  await atomicJson(join(home, 'bots.json'), [bot]);
  const binding = { architecture: 'traex', launcher, launcherHash: digest(await readFile(launcher, 'utf8')),
    native: { command: '/fixture/native-traex', prefixArgs: [], legacy: {
      path: originalPath, hashes: { [originalPath]: digest(original) }, providers: ['original_ferry'], port: 27891,
    } } };
  return { home, bot, binding, originalPath, original };
}

test('legacy bridge preserves the frozen entry path and can be rolled back byte-for-byte', async context => {
  const { home, bot, binding, originalPath, original } = await fixture(context);
  const bridge = await prepareLegacyBridge(binding, bot.larkAppId, home);
  assert.equal(await readFile(originalPath, 'utf8'), original);
  await applyLegacyBridge(bridge);
  assert.match(await readFile(originalPath, 'utf8'), /private\/launch/);
  assert.equal((await readJson(join(home, 'bots.json')))[0].cliPathOverride, originalPath);
  const plan = await controlLaunchPlan({ bot, binding, args: ['resume', 'fixture-history'],
    env: {}, history: { provider: 'original_ferry', model: 'ferry-gpt-6-1-sol-max', effort: 'xhigh' },
    runtime: { online: false }, scopeEnabled: true });
  assert.equal(plan.legacy, true);
  assert.equal(plan.command, '/fixture/native-traex');
  assert.ok(plan.args.some(value => value.includes('model_provider="original_ferry"')));
  assert.ok(plan.args.includes('model="ferry-gpt-6-1-sol-max"'));
  assert.ok(plan.args.includes('model_reasoning_effort="xhigh"'));
  assert.ok(plan.args.includes('model_providers.original_ferry.wire_api="responses"'));
  await restoreLegacyBridge(bridge);
  assert.equal(await readFile(originalPath, 'utf8'), original);
});

test('legacy bridge refuses a shared entry or an independently modified launcher', async context => {
  const { home, bot, binding, originalPath } = await fixture(context);
  await atomicJson(join(home, 'bots.json'), [bot, { ...bot, larkAppId: 'cli_other_owner' }]);
  await assert.rejects(prepareLegacyBridge(binding, bot.larkAppId, home), /多个 Bot 共用/);
  await atomicJson(join(home, 'bots.json'), [bot]);
  const bridge = await prepareLegacyBridge(binding, bot.larkAppId, home);
  await writeFile(originalPath, 'changed independently');
  await assert.rejects(applyLegacyBridge(bridge), /并发修改/);
  await assert.rejects(restoreLegacyBridge(bridge), /无法安全回滚/);
  assert.equal(await readFile(originalPath, 'utf8'), 'changed independently');
});

test('TraeX new-topic switch installs a history-safe bridge without changing consumed legacy flags', async context => {
  const { home, bot, binding, originalPath } = await fixture(context);
  const profileId = 'legacy-arbitrary';
  const flag = join(home, 'local', profileId, 'acceleration.json');
  await atomicJson(flag, { enabled: true, keep: 'unchanged' });
  await writeFile(join(home, '.dashboard-token'), 'fixture-authority');
  await atomicJson(join(home, 'plugins-registry.json'), { plugins: { 'gateway-acceleration': {} } });
  await atomicJson(join(home, 'plugins/gateway-acceleration/config.json'), {
    profiles: [{ id: profileId, appId: bot.larkAppId }],
  });
  const deps = {
    request: async () => ({ bots: [] }),
    gatewayModels: async () => [{ codex: 'ferry-gpt-6-1-sol-max', name: 'GPT-6.1-Sol Max', trae: 'gpt-6.1-sol__max',
      context: 1000000, efforts: ['xhigh'], acceleration_supported: true }],
    nativeModelCatalog: async () => ({ models: ['GPT-6.1-Sol'], modelCapabilities: [{
      slug: 'GPT-6.1-Sol', contextVariants: [{ id: 'max', contextWindow: 800000, reasoningEfforts: ['xhigh'] }],
    }] }),
    managedRuntimeStatus: async () => ({ online: true, ready: true, port: 27892, pid: 12 }),
    legacyStatus: async () => ({ profiles: [{ appId: bot.larkAppId, enabled: (await readJson(flag)).enabled,
      connection: { verified: true, enabled: true }, controlAvailable: false, health: { online: true } }] }),
    prepareClientBinding: async () => structuredClone(binding),
    prepareClientCatalog: async () => '/fixture/catalog.json',
    reloadBot: async () => { throw new Error('The frozen entry path must not change or reload'); },
  };
  const before = await readFile(join(home, 'bots.json'), 'utf8');
  for (const enabled of [false, true]) {
    const profile = (await controlStatus(home, deps)).profiles[0];
    await setControl({ profileId: profile.id, revision: profile.revision, action: 'master', enabled }, home, deps);
    assert.deepEqual(await readJson(flag), { enabled: true, keep: 'unchanged' });
    assert.equal((await controlStatus(home, deps)).profiles[0].enabled, enabled);
    assert.equal(await readFile(join(home, 'bots.json'), 'utf8'), before);
  }
  assert.match(await readFile(originalPath, 'utf8'), /private\/launch/);
});
