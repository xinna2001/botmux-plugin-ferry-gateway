import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { atomicJson } from '../shared/state.mjs';
import { setDefaultScope, controlState } from '../gateway/src/lib/control-plane.mjs';
import { startVersionCheck, queryLatestVersion, versionCheckStatus } from '../gateway/src/lib/version-check.mjs';
import { supportedRuntimes } from '../gateway/src/lib/runtime-instrument.mjs';
import { mergeSnapshot } from '../gateway/src/dashboard/state.mjs';

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'ferry-080-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const bots = [{ larkAppId: 'cli_self_fixture', cliId: 'traex', model: 'GPT-fixture',
    plugins: ['gateway-acceleration'], reasoningEffort: 'xhigh' },
  { larkAppId: 'cli_peer_fixture', cliId: 'codex', model: 'ferry-gpt-fixture', plugins: ['gateway-acceleration'] }];
  const binding = { acceleration: true, forwarding: true, launcher: '/must/not/be/read',
    launcherHash: 'invalid-for-off-test', native: { legacy: { hashes: { '/must/not/be/read': 'invalid' } } } };
  const config = { controlPlane: { bots: Object.fromEntries(bots.map(bot => [bot.larkAppId, binding])) } };
  await atomicJson(join(home, 'bots.json'), bots); await atomicJson(join(home, 'config.json'), {});
  await atomicJson(join(home, 'plugins-registry.json'), { plugins: { 'gateway-acceleration': {} } });
  await atomicJson(join(home, 'plugins/gateway-acceleration/config.json'), config);
  await writeFile(join(home, '.dashboard-token'), 'fixture-owner-authority');
  await atomicJson(join(home, 'plugins/gateway-acceleration/private/runtime/prepared.json'), {
    version: '0.1.98', sourceHash: supportedRuntimes['0.1.98'].sha256 });
  return { home, bots, config };
}
const integrity = `sha512-${'a'.repeat(86)}==`;
const response = version => new Response(JSON.stringify({ name: '@ad/ferry', version, dist: { integrity } }));
async function finished(home) {
  for (let i = 0; i < 50; i++) {
    const value = await versionCheckStatus(home);
    if (value?.state !== 'checking') return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('version check did not reach terminal state');
}

test('checking latest is metadata-only and cannot install or alter routing/configuration', async t => {
  const { home, config } = await fixture(t); let fetches = 0;
  const value = await queryLatestVersion(home, { fetcher: async () => { fetches++; return response('0.1.120'); },
    detectFerry: () => { throw new Error('must not discover'); }, ensureManagedRuntime: () => { throw new Error('must not start'); } });
  assert.equal(fetches, 1); assert.equal(value.latestVersion, '0.1.120'); assert.equal(value.canUpdate, true);
  assert.deepEqual(JSON.parse(await readFile(join(home, 'plugins/gateway-acceleration/config.json'))), config);
});
test('unknown latest still displays its exact version but cannot enable updating', async t => {
  const { home } = await fixture(t);
  const value = await queryLatestVersion(home, { fetcher: async () => response('0.1.121') });
  assert.equal(value.latestVersion, '0.1.121'); assert.equal(value.supported, false); assert.equal(value.canUpdate, false);
});
test('version-check jobs are separate from setup, and concurrent checks join one bounded query', async t => {
  const { home } = await fixture(t); let release, count = 0;
  const blocked = new Promise(resolve => { release = resolve; });
  await atomicJson(join(home, 'plugins/gateway-acceleration/private/setup-job.json'), { state: 'complete', operation: 'preserved' });
  const deps = { fetcher: async () => { count++; await blocked; return response('0.1.120'); } };
  const first = await startVersionCheck(home, deps), second = await startVersionCheck(home, deps);
  assert.equal(first.id, second.id); release(); assert.equal((await finished(home)).state, 'complete');
  assert.equal(count, 1);
  assert.equal(JSON.parse(await readFile(join(home, 'plugins/gateway-acceleration/private/setup-job.json'))).operation, 'preserved');
});
test('query timeout is terminal failure, never latest or an unusable installation', async t => {
  const { home } = await fixture(t);
  await startVersionCheck(home, { fetcher: async () => { throw new DOMException('timeout', 'TimeoutError'); } });
  const value = await finished(home); assert.equal(value.state, 'failed'); assert.match(value.error, /超时/);
  assert.equal((await controlState(home)).profiles[0].pluginEnabled, true);
});
test('switching self off ignores offline runtimes, unavailable models and changed launchers', async t => {
  const { home, bots, config } = await fixture(t), before = await readFile(join(home, 'bots.json'));
  const deps = { managedRuntimeStatus: () => { throw new Error('off must not query'); },
    nativeModelCatalog: () => { throw new Error('off must not enumerate models'); } };
  const state = await setDefaultScope({ appId: bots[0].larkAppId, enabled: false }, home, deps);
  assert.equal(state.profiles[0].pluginEnabled, false); assert.equal(state.profiles[1].pluginEnabled, true);
  const saved = JSON.parse(await readFile(join(home, 'plugins/gateway-acceleration/config.json')));
  assert.deepEqual(saved.controlPlane, config.controlPlane); assert.deepEqual(await readFile(join(home, 'bots.json')), before);
  assert.equal(saved.topicDefaults.bindings[bots[0].larkAppId].acceleration, false);
});
test('turning one bot off while all-on preserves every other bot, and all-off clears every card', async t => {
  const { home, bots, config } = await fixture(t);
  config.topicDefaults = { globalEnabled: true };
  await atomicJson(join(home, 'plugins/gateway-acceleration/config.json'), config);
  const selfOff = await setDefaultScope({ appId: bots[0].larkAppId, enabled: false }, home);
  assert.equal(selfOff.defaults.globalEnabled, false); assert.equal(selfOff.profiles[1].pluginEnabled, true);
  const allOff = await setDefaultScope({ appId: 'global', enabled: false }, home);
  assert.ok(allOff.profiles.every(profile => !profile.pluginEnabled));
});
test('late full snapshots cannot resurrect an already-disabled card or regress update progress', () => {
  const current = { scopeRevision: 2, defaults: { globalEnabled: false }, profiles: [
    { appId: 'self', pluginEnabled: false, enabled: false, connection: { enabled: false } }],
  setup: { job: { id: 'update', startedAt: 10, state: 'running', percent: 60 } } };
  const stale = { scopeRevision: 1, defaults: { globalEnabled: true }, profiles: [
    { appId: 'self', pluginEnabled: true, enabled: true, connection: { enabled: true } }],
  setup: { job: { id: 'update', startedAt: 10, state: 'running', percent: 20 } } };
  const value = mergeSnapshot(current, stale);
  assert.equal(value.profiles[0].pluginEnabled, false); assert.equal(value.defaults.globalEnabled, false);
  assert.equal(value.setup.job.percent, 60);
});
test('cached adapter loader reimports implementation by bytes rather than path/mtime', async t => {
  const home = await mkdtemp(join(tmpdir(), 'ferry-080-loader-')); t.after(() => rm(home, { recursive: true, force: true }));
  const loader = join(home, 'loader.mjs');
  await writeFile(loader, await readFile(new URL('../gateway/src/server/loader.mjs', import.meta.url)));
  const code = version => `export const getSettings=()=>(${version});export const saveSettings=()=>(${version});`;
  async function install(version) {
    const bytes = code(version), sha256 = createHash('sha256').update(bytes).digest('hex');
    const file = `settings-${sha256}.mjs`;
    await writeFile(join(home, file), bytes);
    await atomicJson(join(home, 'settings-entry.json'), { file, sha256 });
    return join(home, file);
  }
  await install(1);
  const adapter = await import(pathToFileURL(loader).href);
  assert.equal(await adapter.getSettings(), 1); await install(2);
  assert.equal(await adapter.getSettings(), 2);
  assert.equal(await adapter.saveSettings(), 2);
  const file = await install(1);
  assert.equal(await adapter.getSettings(), 1, 'rollback loads the exact old implementation');
  await writeFile(file, code(9));
  await assert.rejects(adapter.getSettings(), /校验失败/);
  await atomicJson(join(home, 'settings-entry.json'), { file: '../outside.mjs', sha256: '0'.repeat(64) });
  await assert.rejects(adapter.getSettings(), /版本描述无效/);
});
