import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicJson, readJson, pluginConfig, digest } from '../shared/state.mjs';
import { status, setAcceleration, setForwarding, reconcileScopes } from '../gateway/src/lib/gateway.mjs';

const ID = 'gateway-acceleration';
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'ferry-state-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const launcher = join(home, 'launcher');
  await writeFile(launcher, '#!/bin/sh\n# fixture only\n');
  const bot = { larkAppId: 'cli_fixture', name: 'Fixture', cliId: 'codex',
    model: 'ferry-gpt-6-astra-max', cliPathOverride: launcher, plugins: [ID] };
  const profile = { id: 'ferry-fixture', appId: bot.larkAppId, model: bot.model, port: 28790,
    route: { mode: 'pinned-launcher', path: launcher, sha256: digest(await readFile(launcher, 'utf8')),
      cliId: bot.cliId, port: 28790, model: bot.model },
    acceleration: { kind: 'existing-flag-v1', control: 'acceleration-only', models: [bot.model] } };
  await atomicJson(join(home, 'bots.json'), [bot]);
  await atomicJson(join(home, 'plugins-registry.json'), { plugins: { [ID]: {} } });
  await atomicJson(pluginConfig(ID, home), { profiles: [profile] });
  await atomicJson(join(home, 'local', profile.id, 'data/runtime.json'), { port: profile.port, pid: 42, token: 'fixture-token' });
  const fetcher = async () => ({ ok: true, json: async () => ({ ok: true, port: profile.port, pid: 42, version: 'fixture' }) });
  const row = async () => (await status(home, fetcher)).profiles[0];
  const toggle = async enabled => {
    const current = await row();
    return setAcceleration({ profileId: current.id, enabled, revision: current.revision }, home, { fetcher });
  };
  return { home, bot, profile, fetcher, row, toggle };
}
test('acceleration toggles preserve the Bot and verified forwarding route', async t => {
  const { home, row, toggle } = await fixture(t);
  const before = await readFile(join(home, 'bots.json'), 'utf8');
  const connection = (await row()).connection;
  await toggle(true);
  assert.equal((await row()).enabled, true);
  await toggle(false);
  assert.equal((await row()).enabled, false);
  assert.deepEqual((await row()).connection, connection);
  assert.equal(await readFile(join(home, 'bots.json'), 'utf8'), before);
});
test('a model change rejects stale approval and non-GPT activation', async t => {
  const { home, bot, row, toggle, fetcher } = await fixture(t);
  const current = await row();
  bot.model = 'ferry-gemini-example';
  await atomicJson(join(home, 'bots.json'), [bot]);
  await assert.rejects(setAcceleration({ profileId: current.id, enabled: true, revision: current.revision }, home, { fetcher }));
  const before = await readFile(join(home, 'bots.json'), 'utf8');
  await assert.rejects(toggle(true));
  assert.equal((await row()).enabled, false);
  assert.equal(await readFile(join(home, 'bots.json'), 'utf8'), before);
});
test('legacy coupled flags are not toggled or reconciled automatically', async t => {
  const { home, profile, row, toggle } = await fixture(t);
  const config = { profiles: [{ ...profile, acceleration: { ...profile.acceleration, control: undefined } }],
    managedProfiles: { [profile.id]: { requested: false } } };
  await atomicJson(pluginConfig(ID, home), config);
  const flag = join(home, 'local', profile.id, 'acceleration.json');
  await atomicJson(flag, { enabled: true });
  assert.equal((await row()).controlAvailable, false);
  await assert.rejects(toggle(true));
  await assert.rejects(toggle(false));
  await reconcileScopes(home);
  assert.equal((await readJson(flag)).enabled, true);
});
test('forwarding preferences do not overwrite acceleration or Bot settings', async t => {
  const { home, bot, profile, row, toggle, fetcher } = await fixture(t);
  bot.model = 'gpt-fixture';
  await atomicJson(join(home, 'bots.json'), [bot]);
  profile.client = { cliId: bot.cliId, command: '/fixture/codex', provider: 'ferry', model: bot.model };
  profile.forwarding = { kind: 'separate-flag-v1' };
  await atomicJson(pluginConfig(ID, home), { profiles: [profile] });
  const before = await readFile(join(home, 'bots.json'), 'utf8');
  for (const enabled of [true, false]) {
    const current = await row();
    await setForwarding({ profileId: current.id, enabled, revision: current.revision }, home, { fetcher });
    if (enabled) await toggle(true);
  }
  assert.equal((await readJson(join(home, 'local', profile.id, 'acceleration.json'))).enabled, true);
  assert.equal(await readFile(join(home, 'bots.json'), 'utf8'), before);
});
test('changing a pinned wrapper invalidates route eligibility', async t => {
  const { bot, row, toggle } = await fixture(t);
  await writeFile(bot.cliPathOverride, '#!/bin/sh\n# modified fixture\n');
  assert.equal((await row()).compatibility.eligible, false);
  await assert.rejects(toggle(true));
});
