import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicJson } from '../shared/state.mjs';
import { currentTopicStatus } from '../gateway/src/lib/topic-status.mjs';

test('current-topic status distinguishes defaults, actual request, historical rank and secret fields', async t => {
  const home = await mkdtemp(join(tmpdir(), 'gateway-topic-status090-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const appId = 'cli_status_fixture', sessionId = '00000000-0000-4000-8000-000000000093';
  const env = { BOTMUX_LARK_APP_ID: appId, BOTMUX_SESSION_ID: sessionId };
  const base = join(home, 'plugins/gateway-acceleration/private');
  await atomicJson(join(base, 'topics', appId, `${sessionId}.json`), {
    schemaVersion: 1, appId, sessionId, scopeEnabled: true, bot: {}, binding: {},
    runtime: { version: '0.1.98', token: 'NEVER_EXPORT' },
  });
  await atomicJson(join(home, 'plugins/gateway-acceleration/config.json'),
    { liveControls: { bots: { [appId]: { enabled: false, revision: 3 } } } });
  await atomicJson(join(base, 'requests', appId, `${sessionId}.json`), {
    phase: 'queued', position: 2000, observedAt: 1000, model: 'ferry-gpt-6-1-sol-max',
    reasoningEffort: 'xhigh', controlProtocol: 1, accelerationRetries: 2, nextRetryAt: 16000,
    failureMessage: 'NEVER_EXPORT_RAW_ERROR', prompt: 'NEVER_EXPORT_PROMPT',
  });
  const fresh = await currentTopicStatus(home, env, 2000);
  assert.equal(fresh.queuePosition, 2000);
  assert.equal(fresh.defaultLiveControl.enabled, false);
  assert.equal(fresh.request.accelerationRetries, 2);
  assert.equal(fresh.topicOriginalRuntimeVersion, '0.1.98');
  const old = await currentTopicStatus(home, env, 200000);
  assert.equal(old.state, 'historical');
  assert.equal(old.queuePosition, undefined);
  assert.doesNotMatch(JSON.stringify(fresh), /NEVER_EXPORT/);
  await atomicJson(join(base, 'requests', appId, `${sessionId}.json`), {
    phase: 'answering', position: 2000, observedAt: 1000, generated: true,
    routeStatus: 'accepted', routeSource: 'conversation-affinity', affinityPersisted: true,
  });
  const answering = await currentTopicStatus(home, env, 2000);
  assert.equal(answering.queuePosition, undefined, 'old queued rank cannot label an answering request');
  assert.equal(answering.request.routeSource, 'conversation-affinity');
  assert.equal(answering.request.affinityPersisted, true);
  assert.equal(await currentTopicStatus(home, {}), null);
});
