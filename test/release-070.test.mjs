import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { atomicJson } from '../shared/state.mjs';
import { supportedRuntime, supportedRuntimes, runtimeVersion, sourceRuntime } from '../gateway/src/lib/runtime-instrument.mjs';
import { prepareInstall } from '../gateway/src/lib/setup.mjs';
import { createController } from '../gateway/src/lib/runtime-policy.mjs';
import { cachedPreparationStatus } from '../gateway/src/lib/preparation-cache.mjs';
import { checkAndUpdate } from '../gateway/src/lib/update.mjs';

test('default version is 0.1.120 and both exact official identities remain available', () => {
  assert.equal(supportedRuntime.version, '0.1.120');
  assert.deepEqual(Object.keys(supportedRuntimes), ['0.1.98', '0.1.120']);
  for (const version of Object.keys(supportedRuntimes)) {
    const r = runtimeVersion(version);
    assert.equal(sourceRuntime(r.sha256, version)?.version, version);
    assert.equal(sourceRuntime(r.sha256, version === '0.1.98' ? '0.1.120' : '0.1.98'), undefined);
  }
  assert.throws(() => runtimeVersion('0.1.121'));
  assert.throws(() => runtimeVersion('__proto__'));
  assert.equal(sourceRuntime('0'.repeat(64)), undefined);
});
test('a fresh installation asks for 0.1.120; explicit legacy maintenance can still ask for 0.1.98', async t => {
  const home = await mkdtemp(join(tmpdir(), 'gateway-default-070-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, '.dashboard-token'), 'fixture-only');
  const requested = [];
  const run = async (command, args) => {
    if (args[0] === 'root') return { stdout: join(home, 'no-global-packages') };
    if (command === 'node') return { stdout: 'v24.16.0' };
    const version = args[1].split('@').at(-1);
    requested.push(version);
    return { stdout: JSON.stringify({ version, 'dist.integrity': `sha512-${'a'.repeat(86)}==` }) };
  };
  assert.equal((await prepareInstall(home, { run })).version, '0.1.120');
  assert.equal((await prepareInstall(home, { run, targetVersion: '0.1.98' })).version, '0.1.98');
  assert.deepEqual(requested, ['0.1.120', '0.1.98']);
});
for (const reason of ['manual-cancel', 'upstream-rejected']) test(`${reason} persists across requests without rewriting the topic's default snapshot`, async t => {
  const home = await mkdtemp(join(tmpdir(), 'gateway-native-control-070-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const appId = 'cli_native_control_fixture', sessionId = '00000000-0000-4000-8000-000000000707';
  const bot = { larkAppId: appId, cliId: 'codex', model: 'ferry-gpt-6-1-sol',
    reasoningEffort: 'xhigh', plugins: ['gateway-acceleration'] };
  const binding = { architecture: 'codex', forwarding: true, acceleration: true, selection: {
    ferryModel: bot.model, clientModel: bot.model, efforts: ['xhigh'], accelerationAvailable: true } };
  await atomicJson(join(home, 'bots.json'), [bot]);
  await atomicJson(join(home, 'plugins-registry.json'), { plugins: { 'gateway-acceleration': {} } });
  await atomicJson(join(home, 'plugins/gateway-acceleration/config.json'), { controlPlane: { bots: { [appId]: binding } } });
  const file = join(home, 'plugins/gateway-acceleration/private/topics', appId, `${sessionId}.json`);
  await atomicJson(file, { schemaVersion: 1, appId, sessionId, bot, binding, scopeEnabled: true });
  const before = await readFile(file, 'utf8');
  const turn = { botmuxAppId: appId, botmuxSessionId: sessionId, requestId: 'fixture-request',
    model: { codexId: bot.model }, botmuxRequestedModel: bot.model, reasoningEffort: 'xhigh',
    nativeAccelerationSupported: true, signal: new AbortController().signal };
  const first = createController(turn, { home, write() {} });
  assert.equal(first.canAccelerate(), true);
  first.suppress(reason);
  assert.equal(first.canAccelerate(), false);
  const next = createController({ ...turn, requestId: 'next' }, { home, write() {} });
  assert.equal(next.canAccelerate(), false);
  next.resume();
  assert.equal(next.canAccelerate(), true);
  assert.equal(await readFile(file, 'utf8'), before);
});
test('native rejection state is honored without rereading mutable Bot defaults', async t => {
  const home = await mkdtemp(join(tmpdir(), 'gateway-rejection-070-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const appId = 'cli_rejection_fixture', sessionId = '00000000-0000-4000-8000-000000000708';
  const bot = { larkAppId: appId, cliId: 'codex', model: 'ferry-gpt-6-1-sol', reasoningEffort: 'xhigh' };
  const binding = { architecture: 'codex', forwarding: true, acceleration: true,
    selection: { clientModel: bot.model, ferryModel: bot.model, efforts: ['xhigh'], accelerationAvailable: true } };
  await atomicJson(join(home, 'bots.json'), [{ ...bot, plugins: ['gateway-acceleration'] }]);
  await atomicJson(join(home, 'plugins-registry.json'), { plugins: { 'gateway-acceleration': {} } });
  await atomicJson(join(home, 'plugins/gateway-acceleration/config.json'), { controlPlane: { bots: { [appId]: binding } } });
  await atomicJson(join(home, 'plugins/gateway-acceleration/private/topics', appId, `${sessionId}.json`),
    { schemaVersion: 1, appId, sessionId, bot, binding, scopeEnabled: true });
  let allowed = true;
  const controller = createController({ botmuxAppId: appId, botmuxSessionId: sessionId,
    model: { codexId: bot.model }, botmuxRequestedModel: bot.model, reasoningEffort: 'xhigh',
    nativeAccelerationSupported: true, nativeAccelerationPermitted: () => allowed }, { home, write() {} });
  assert.equal(controller.canAccelerate(), true);
  allowed = false;
  assert.equal(controller.canAccelerate(), false);
});
test('a serving-version switch refreshes the cached version exactly once', async t => {
  const home = await mkdtemp(join(tmpdir(), 'gateway-cache-version-070-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  let version = '0.1.98', scans = 0;
  const deps = {
    runtimeStatus: async () => ({ ready: true }),
    detectFerry: async () => ({ version }),
    setupStatus: async () => { scans++; return { installed: true, version, adapterCompatible: true, authenticated: true }; },
  };
  const serving = () => ({ ready: true, online: true, authenticated: true, catalogReady: true,
    dependencies: { ready: true }, upstreamVersion: version });
  assert.equal((await cachedPreparationStatus(home, deps, serving())).version, '0.1.98');
  version = '0.1.120';
  assert.equal((await cachedPreparationStatus(home, deps, serving())).version, '0.1.120');
  assert.equal((await cachedPreparationStatus(home, deps, serving())).version, '0.1.120');
  assert.equal(scans, 2);
});
test('the update check prefers the serving 0.1.120 dependency over a preserved configured 0.1.98', async t => {
  const home = await mkdtemp(join(tmpdir(), 'gateway-update-current-070-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, '.dashboard-token'), 'fixture-authority');
  await atomicJson(join(home, 'plugins/gateway-acceleration/private/runtime/prepared.json'),
    { version: '0.1.120', sourceHash: supportedRuntime.sha256 });
  let operations = 0;
  const value = await checkAndUpdate(home, {
    detectFerry: async (_home, options) => ({ version: options?.targetVersion || '0.1.98' }),
    run: async () => { operations++; return { stdout: JSON.stringify({ version: '0.1.120',
      'dist.integrity': `sha512-${'a'.repeat(86)}==` }) }; },
  });
  assert.equal(value.updated, false);
  assert.equal(value.version, '0.1.120');
  assert.equal(operations, 1);
});
