import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { atomicJson, digest } from '../shared/state.mjs';
import { supportedRuntime } from '../gateway/src/lib/runtime-instrument.mjs';
import { queuedRecovery } from '../gateway/src/lib/queued-recovery.mjs';

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'queued-gateway-recovery-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const appId = 'cli_recovery', sessionId = '00000000-0000-4000-8000-000000000080';
  const nativeSessionId = '00000000-0000-4000-8000-000000000081';
  const base = join(home, 'plugins/gateway-acceleration/private');
  const topic = { scopeEnabled: true, bot: { reasoningEffort: 'xhigh' },
    binding: { selection: { ferryModel: 'ferry-gpt-6-1-sol-max' } } };
  await atomicJson(join(base, 'topics', appId, `${sessionId}.json`), topic);
  const transcript = join(home, `rollout-${nativeSessionId}.jsonl`);
  const prefix = '{"type":"fixture-owned-history"}\n';
  await writeFile(transcript, prefix);
  const dir = join(base, 'runtime/generations/owned-test');
  await mkdir(dir, { recursive: true });
  const program = join(dir, 'cli.botmux.mjs');
  await writeFile(program, '// owned fixture');
  await writeFile(join(dir, 'botmux-policy.mjs'), '// owned policy');
  const record = { schemaVersion: 1, authorized: true, appId, sessionId, nativeSessionId,
    topicHash: digest(topic), transcript, prefixBytes: Buffer.byteLength(prefix), prefixHash: digest(prefix),
    expiresAt: Date.now() + 60000, history: { provider: 'botmux_ferry',
      model: 'ferry-gpt-6-1-sol-max', effort: 'xhigh' }, runtime: {
      sourceHash: supportedRuntime.sha256, version: supportedRuntime.version, program,
      programHash: digest('// owned fixture'), policyHash: digest('// owned policy') } };
  const path = join(base, 'queued-recovery', appId, `${sessionId}.json`);
  await atomicJson(path, record);
  return { home, appId, sessionId, nativeSessionId, record, path, transcript,
    read: () => queuedRecovery(home, appId, sessionId, ['resume', nativeSessionId]) };
}

test('only an exact approved original ID and immutable history can recover an unfinished queue', async t => {
  const f = await fixture(t);
  assert.equal((await f.read()).unfinishedAllowed, true);
  await assert.rejects(queuedRecovery(f.home, f.appId, f.sessionId,
    ['resume', '00000000-0000-4000-8000-000000000082']), /原 ID/);
  await appendFile(f.transcript, '{"type":"event_msg","payload":{"type":"turn_aborted"}}\n');
  assert.equal((await f.read()).unfinishedAllowed, true);
  await appendFile(f.transcript, '{"type":"turn_context","payload":{"effort":"low"}}\n');
  assert.equal((await f.read()).unfinishedAllowed, false);
});

test('expiration disables only unfinished fallback; the approved runtime remains pinned', async t => {
  const f = await fixture(t);
  const result = await queuedRecovery(f.home, f.appId, f.sessionId,
    ['resume', f.nativeSessionId], f.record.expiresAt + 1);
  assert.equal(result.unfinishedAllowed, false);
  assert.deepEqual(result.runtime, f.record.runtime);
});

test('tampered transcript, model, or program fails closed', async t => {
  const f = await fixture(t);
  await atomicJson(f.path, { ...f.record, history: { ...f.record.history, effort: 'medium' } });
  await assert.rejects(f.read(), /不得改模型/);
  await atomicJson(f.path, f.record);
  await writeFile(f.record.runtime.program, '// replaced');
  await assert.rejects(f.read(), /目标网关/);
  await writeFile(f.record.runtime.program, '// owned fixture');
  await writeFile(f.transcript, '{"type":"changed-history"}\n');
  await assert.rejects(f.read(), /历史发生改写/);
});
