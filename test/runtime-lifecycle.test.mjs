import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { atomicJson } from '../shared/state.mjs';
import { recoverManagedRuntime } from '../gateway/src/lib/managed-runtime.mjs';
import { instrumentRuntime } from '../gateway/src/lib/runtime-instrument.mjs';
import { loginUrlFromLine, startJob, getJobStatus } from '../gateway/src/lib/setup.mjs';
import { resolveNativeClient } from '../gateway/src/lib/client-binding.mjs';

test('recovery is opt-in and concurrent service polls create one runtime only', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ferry-recovery-'));
  try {
    let calls = 0;
    const deps = { ensureManagedRuntime: async () => {
      calls++;
      await new Promise(resolve => setTimeout(resolve, 20));
      return { online: true };
    } };
    await recoverManagedRuntime(home, deps);
    assert.equal(calls, 0);
    await atomicJson(join(home, 'plugins/gateway-acceleration/config.json'), { controlPlane: { runtimeWanted: true } });
    const results = await Promise.all([recoverManagedRuntime(home, deps), recoverManagedRuntime(home, deps)]);
    assert.equal(calls, 1);
    assert.ok(results.every(result => result.online));
    await assert.rejects(recoverManagedRuntime(home, { ensureManagedRuntime: async () => { throw new Error('offline'); } }));
    await recoverManagedRuntime(home, deps);
    assert.equal(calls, 2);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('unknown upstream sources are never instrumented', () => {
  assert.throws(() => instrumentRuntime('export const version = "0.1.98";'), /已核验版本/);
});

test('login links reject lookalike domains, userinfo and non-HTTPS schemes', () => {
  assert.equal(loginUrlFromLine('Login: https://sso.bytedance.com/login?code=example'), 'https://sso.bytedance.com/login?code=example');
  for (const value of ['https://bytedance.com.evil.invalid/login', 'https://user:pass@bytedance.com/login',
    'http://bytedance.com/login', 'javascript:alert(1)']) assert.equal(loginUrlFromLine(value), null);
});

test('login job URL is only visible while awaiting personal authorization', async () => {
  const home = `fixture-${Date.now()}`;
  let finish;
  startJob('login', async job => {
    job.loginUrl = 'https://sso.bytedance.com/login?code=fixture';
    await new Promise(resolve => { finish = resolve; });
  }, home);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(getJobStatus(home).state, 'running');
  assert.ok(getJobStatus(home).loginUrl);
  assert.throws(() => startJob('login', async () => {}, home), /进行中/);
  finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(getJobStatus(home).state, 'complete');
  assert.equal(getJobStatus(home).loginUrl, undefined);
});

test('unsupported isolation and remote launch modes fail before client execution', async () => {
  for (const restriction of [{ sandbox: true }, { readIsolation: true }, { triggerUserAuth: { enabled: true } },
    { backendType: 'remote-runner' }, { existingAppServer: {} }, { wrapperCli: 'unknown' }]) {
    await assert.rejects(resolveNativeClient({ cliId: 'codex', ...restriction }, undefined, {
      run: async () => { assert.fail('must not execute a client'); },
    }), /未自动接管/);
  }
});
