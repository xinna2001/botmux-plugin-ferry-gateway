import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'smol-toml';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicJson } from '../shared/state.mjs';
import { buildClientLaunch, clientModelMatches, launchState } from '../gateway/src/lib/client-launcher.mjs';
import { compatibility } from '../gateway/src/lib/gateway.mjs';

const bot = { cliId: 'traex', model: 'GPT-6.1-Sol', reasoningEffort: 'xhigh', modelBackendVariant: 'max' };
const profile = {
  appId: 'cli_fixture', model: 'ferry-gpt-6-1-sol-max', port: 28791,
  client: { cliId: 'traex', command: '/fixture/traex', provider: 'ferry_fixture', nativeProvider: 'trae', model: bot.model, reasoningEffort: 'xhigh', backendVariant: 'max' },
  acceleration: { kind: 'existing-flag-v1', control: 'acceleration-only', models: ['ferry-gpt-6-1-sol-max'] },
};
const launch = values => buildClientLaunch({ bot, profile, args: [], forwarding: false, acceleration: false, ...values });
function configs(args) {
  return args.flatMap((arg, i) => arg === '-c' ? [parse(args[i + 1])] : []);
}
test('TraeX acceleration uses the verified same model without changing requested effort', () => {
  const args = ['--model', bot.model, '-c', 'model_reasoning_effort="xhigh"', '--', 'literal --model prompt'];
  const result = launch({ args, acceleration: true, env: { BOTMUX_SESSION_ID: 'fixture-session' } });
  assert.equal(result.command, '/fixture/traex');
  assert.equal(result.gateway, true);
  assert.deepEqual(result.args.slice(-2), ['--', 'literal --model prompt']);
  assert.ok(configs(result.args).some(value => value.model === profile.model));
  assert.ok(configs(result.args).some(value => value.model_reasoning_effort === 'xhigh'));
  assert.ok(!configs(result.args).some(value => value.model_context_window !== undefined));
  assert.equal(compatibility(bot, profile, { verified: true }, true, true).eligible, true);
});
test('unknown model, effort, or context variant is rejected, not silently replaced', () => {
  assert.equal(clientModelMatches({ ...bot, modelBackendVariant: 'standard' }, profile), false);
  for (const changed of [{ model: 'GPT-other' }, { reasoningEffort: 'low' }]) {
    assert.throws(() => launch({ bot: { ...bot, ...changed }, acceleration: true }));
  }
  assert.throws(() => launch({ args: ['-m', 'GPT-other'], acceleration: true }));
  assert.throws(() => launch({ args: ['-c', 'model_reasoning_effort="low"'], acceleration: true }));
});
test('TraeX acceleration off leaves new native invocations unchanged', () => {
  const args = ['--model', bot.model, '--', 'hello'];
  const result = launch({ args, forwarding: true });
  assert.equal(result.gateway, false);
  assert.deepEqual(result.args, args);
});
test('cold resumes retain their provider regardless of the current switch', () => {
  assert.equal(launch({ args: ['resume', 'fixture'], acceleration: false, resumedProvider: 'ferry_fixture' }).gateway, true);
  assert.equal(launch({ args: ['resume', 'fixture'], acceleration: true, resumedProvider: 'trae' }).gateway, false);
  assert.throws(() => launch({ args: ['resume', 'fixture'], acceleration: true }), /无法核验/);
  assert.throws(() => launch({ args: ['resume', 'fixture'], resumedProvider: 'other' }), /其他线路/);
});
test('Codex forwarding does not depend on the acceleration preference', () => {
  const codex = { ...bot, cliId: 'codex', model: 'gpt-fixture' };
  const route = { ...profile, client: { ...profile.client, cliId: 'codex', model: codex.model, command: '/fixture/codex', nativeProvider: 'openai' } };
  for (const acceleration of [false, true]) {
    assert.equal(launch({ bot: codex, profile: route, forwarding: true, acceleration }).gateway, true);
    assert.equal(launch({ bot: codex, profile: route, forwarding: false, acceleration }).gateway, false);
  }
});
test('experimental auto model mode still blocks acceleration for a supported TraeX adapter', () => {
  assert.equal(compatibility({ ...bot, traexAutoModel: { enabled: true } }, profile, { verified: true }, true, true).code, 'auto');
});
test('auto-model mode cannot reuse a previously enabled acceleration flag at launch', async t => {
  const home = await mkdtemp(join(tmpdir(), 'ferry-launch-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const configured = { ...profile, id: 'ferry-test' };
  await atomicJson(join(home, 'local', configured.id, 'acceleration.json'), { enabled: true });
  const result = await launchState({ ...bot, traexAutoModel: { enabled: true } }, configured, home, [], {});
  assert.equal(result.gateway, false);
});
