import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getJobStatus, startJob } from '../gateway/src/lib/setup.mjs';
import { atomicJson } from '../shared/state.mjs';

test('Dashboard sees service progress and cannot start a concurrent installation', async context => {
  const home = await mkdtemp(join(tmpdir(), 'ferry-job-process-'));
  const child = spawn(process.execPath, [join(import.meta.dirname, 'setup-worker.mjs'), home], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = once(child, 'close');
  context.after(async () => { child.kill(); await closed; await rm(home, { recursive: true, force: true }); });
  await once(child.stdout, 'data');
  for (let i = 0; i < 100 && !(await getJobStatus(home))?.loginUrl; i++)
    await new Promise(resolve => setTimeout(resolve, 10));
  const status = await getJobStatus(home);
  assert.equal(status.state, 'running');
  assert.equal(status.progress, 'background fixture preparing');
  assert.match(status.loginUrl, /cross-process/);
  await assert.rejects(startJob('login', async () => assert.fail('duplicate job'), home), /另一个操作/);
  await writeFile(join(home, 'finish'), '');
  const [code] = await closed;
  assert.equal(code, 0);
  assert.equal((await getJobStatus(home)).state, 'complete');
  assert.equal((await getJobStatus(home)).loginUrl, undefined);
});

test('a vanished preparation process reports interruption and allows retry', async context => {
  const home = await mkdtemp(join(tmpdir(), 'ferry-job-interrupted-'));
  context.after(() => rm(home, { recursive: true, force: true }));
  await atomicJson(join(home, 'plugins/gateway-acceleration/private/setup-job.json'),
    { state: 'running', operation: 'login', loginUrl: 'https://sso.bytedance.com/expired' });
  const state = await getJobStatus(home);
  assert.equal(state.state, 'failed');
  assert.equal(state.errorCode, 'setup_interrupted');
  assert.equal(state.loginUrl, undefined);
  await startJob('bootstrap', async () => {}, home);
  for (let i = 0; i < 100 && (await getJobStatus(home)).state === 'running'; i++)
    await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await getJobStatus(home)).state, 'complete');
});
