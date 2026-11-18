import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareDependencies, preparePrerequisites, preparationStatus, startManagedGateway, loginManagedGateway, automaticPreparation } from '../gateway/src/lib/onboarding.mjs';
import { getJobStatus } from '../gateway/src/lib/setup.mjs';

async function fixture(context) {
  const home = await mkdtemp(join(tmpdir(), 'ferry-onboarding-'));
  context.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, '.dashboard-token'), 'fixture-authority');
  await writeFile(join(home, 'bots.json'), '[{"larkAppId":"cli_new_person","model":"unchanged"}]');
  const state = { runtime: false, dependency: false, authenticated: false, gateway: false };
  const calls = [];
  const deps = {
    runtimeStatus: async () => ({ ready: state.runtime, version: state.runtime ? 'v24.16.0' : undefined }),
    installRuntime: async input => { assert.equal(input.confirm, true); calls.push('node-install'); state.runtime = true; },
    detectFerry: async (_home, options) => options.compatibleOnly
      ? state.dependency ? { version: '0.1.98' } : null : { version: '0.2.9', source: 'global' },
    prepareInstall: async () => { calls.push('prepare-install'); return { nonce: 'fixture-confirmation' }; },
    installFerry: async input => {
      assert.deepEqual(input, { nonce: 'fixture-confirmation', confirm: true });
      calls.push('ferry-install'); state.dependency = true;
    },
    setupStatus: async () => ({ installed: state.dependency, adapterCompatible: state.dependency,
      version: state.dependency ? '0.1.98' : undefined, authenticated: state.authenticated }),
    prepareManagedDependencies: async () => ({ ready: true }),
    ensureManagedRuntime: async () => { calls.push('gateway-start'); state.gateway = true;
      return { online: true, ready: true, authenticated: true, catalogReady: true, port: 27891 }; },
  };
  return { home, state, calls, deps };
}

test('clean onboarding automatically installs prerequisites and waits for personal SSO', async context => {
  const { home, state, calls, deps } = await fixture(context);
  const before = await readFile(join(home, 'bots.json'), 'utf8');
  assert.equal((await preparationStatus(home, deps)).phase, 'runtime');
  const job = {};
  assert.deepEqual(await preparePrerequisites(home, deps, job), { requiresLogin: true });
  assert.deepEqual(calls, ['node-install', 'prepare-install', 'ferry-install']);
  assert.equal((await preparationStatus(home, deps)).phase, 'login');
  assert.match(job.progress, /字节内部登录/);
  state.authenticated = true;
  const prepared = await preparePrerequisites(home, deps, job);
  assert.equal(prepared.requiresStart, true);
  assert.ok(!calls.includes('gateway-start'));
  const ready = await startManagedGateway(home, deps, job);
  assert.equal(ready.ready, true);
  assert.deepEqual(calls, ['node-install', 'prepare-install', 'ferry-install', 'gateway-start']);
  const status = await preparationStatus(home, deps, ready.runtime);
  assert.equal(status.phase, 'ready');
  assert.equal(status.detectedVersion, '0.2.9');
  assert.equal(status.version, '0.1.98');
  assert.equal(await readFile(join(home, 'bots.json'), 'utf8'), before);
});

test('install authority prepares dependencies without login or Bot access and is rechecked before each write', async context => {
  const { home, calls, deps } = await fixture(context);
  const before = await readFile(join(home, 'bots.json'), 'utf8');
  const { unlink } = await import('node:fs/promises');
  await unlink(join(home, '.dashboard-token'));
  deps.installAuthority = async () => 'installation-record';
  assert.deepEqual(await prepareDependencies(home, deps), { prepared: true });
  assert.deepEqual(calls, ['node-install', 'prepare-install', 'ferry-install']);
  assert.equal(await readFile(join(home, 'bots.json'), 'utf8'), before);
  await assert.rejects(startManagedGateway(home, deps));
  assert.ok(!calls.includes('gateway-start'));
});

test('revoking installation approval during dependency preparation stops later writes', async context => {
  const { home, calls, deps } = await fixture(context);
  let identity = 'approved';
  deps.installAuthority = async () => identity;
  const install = deps.installRuntime;
  deps.installRuntime = async input => { await install(input); identity = 'revoked'; };
  await assert.rejects(prepareDependencies(home, deps), /授权已失效/);
  assert.ok(!calls.includes('ferry-install'));
});

test('onboarding cannot start a gateway after management authority rotates', async context => {
  const { home, state, calls, deps } = await fixture(context);
  state.authenticated = true;
  const install = deps.installFerry;
  deps.installFerry = async input => {
    await install(input);
    await writeFile(join(home, '.dashboard-token'), 'rotated-authority');
  };
  await assert.rejects(startManagedGateway(home, deps), /管理身份已变化/);
  assert.ok(!calls.includes('gateway-start'));
});

test('an authenticated original installation cannot mark an unauthenticated serving daemon ready', async context => {
  const { home, state, deps } = await fixture(context);
  state.runtime = state.dependency = state.authenticated = true;
  for (const serving of [
    { online: true, authenticated: false, catalogReady: true },
    { online: true, authenticated: true, catalogReady: false },
    { online: true, authenticated: true, catalogReady: true, ready: false, dependencies: { ready: false } },
  ]) assert.equal((await preparationStatus(home, deps, serving)).ready, false);
});

test('dependency failures do not masquerade as ready or proceed to gateway startup', async context => {
  const { home, calls, deps } = await fixture(context);
  deps.installFerry = async () => { throw new Error('fixture registry denied'); };
  await assert.rejects(preparePrerequisites(home, deps), /registry denied/);
  assert.ok(!calls.includes('gateway-start'));
  assert.equal((await preparationStatus(home, deps)).ready, false);
});

test('login repairs missing dependencies before SSO and starts after authorization', async context => {
  const { home, state, calls, deps } = await fixture(context);
  deps.connectFerry = async (input, _home, options) => {
    assert.equal(input.action, 'login');
    assert.equal(state.runtime, true);
    assert.equal(state.dependency, true);
    calls.push('personal-sso');
    options.onLoginUrl('https://sso.bytedance.com/login?fixture=1');
    state.authenticated = true;
  };
  const job = {};
  const result = await loginManagedGateway(home, deps, job);
  assert.equal(result.ready, true);
  assert.equal(job.loginUrl, undefined);
  assert.deepEqual(calls, ['node-install', 'prepare-install', 'ferry-install', 'personal-sso', 'gateway-start']);
});

test('dependency repair rechecks status instead of retaining a pre-repair auth error', async context => {
  const { home, state, deps } = await fixture(context);
  state.runtime = state.dependency = true;
  let repaired = false;
  deps.setupStatus = async () => ({ installed: true, adapterCompatible: true,
    authenticated: false, ...(!repaired ? { statusError: 'fixture missing SDK' } : {}) });
  deps.prepareManagedDependencies = async () => { repaired = true; };
  assert.deepEqual(await preparePrerequisites(home, deps), { requiresLogin: true });
});

test('background preparation works without opening a page and does not loop failures', async context => {
  const { home, calls, deps } = await fixture(context);
  let attempts = 0;
  deps.installFerry = async () => { attempts++; throw new Error('fixture network unavailable'); };
  await automaticPreparation(home, deps);
  for (let i = 0; i < 100 && (await getJobStatus(home)).state === 'running'; i++)
    await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await getJobStatus(home)).state, 'failed');
  await automaticPreparation(home, deps);
  assert.equal(attempts, 1);
  assert.ok(!calls.includes('gateway-start'));
});
