import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { atomicJson, readJson, digest } from '../shared/state.mjs';
import { applyManagedPort, forwardingConfiguration } from '../gateway/src/lib/connection-settings.mjs';

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'gateway-connection090-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, '.dashboard-token'), 'fixture-authority');
  const file = join(home, 'plugins/gateway-acceleration/config.json');
  const config = { preserve: 'unchanged', topicDefaults: { scopes: { cli_other: true } } };
  await atomicJson(file, config);
  return { home, file, config, input: { port: 23190, confirm: true, revision: digest(config) } };
}
test('port cannot claim success until the actual new runtime is ready on that exact port', async t => {
  const f = await fixture(t);
  for (const result of [{ ready: false, port: 23190 }, { ready: true, port: 23191 }]) {
    await assert.rejects(applyManagedPort(f.input, f.home, { ensureManagedRuntime: async () => result }), /未实际生效/);
    assert.deepEqual(await readJson(f.file), f.config);
  }
  let requested;
  const value = await applyManagedPort(f.input, f.home, { ensureManagedRuntime: async (_home, options) => {
    requested = options.requestedPort;
    assert.equal(options.requireReadyBeforePublish, true);
    await options.beforePublish();
    return { ready: true, port: options.requestedPort };
  } });
  assert.equal(requested, 23190);
  assert.equal(value.applied, true);
  const after = await readJson(f.file);
  assert.equal(after.connection.lastAppliedPort, 23190);
  assert.deepEqual(after.topicDefaults, f.config.topicDefaults);
});
test('occupied ports, stale state, revoked authority and missing confirmation do not save fake results', async t => {
  const f = await fixture(t);
  await assert.rejects(applyManagedPort({ ...f.input, confirm: false }, f.home), /明确确认/);
  await assert.rejects(applyManagedPort({ ...f.input, port: 80 }, f.home), /端口/);
  await assert.rejects(applyManagedPort({ ...f.input, revision: 'stale' }, f.home), /配置已变化/);
  await assert.rejects(applyManagedPort(f.input, f.home, { ensureManagedRuntime: async () => {
    throw new Error('FERRY 端口已被占用，未停止或替换已有服务');
  } }), /已被占用/);
  await assert.rejects(applyManagedPort(f.input, f.home, { ensureManagedRuntime: async (_home, options) => {
    await writeFile(join(f.home, '.dashboard-token'), 'rotated');
    await options.beforePublish();
    assert.fail('revoked authority must be rejected before serving-pointer commit');
  } }));
  assert.deepEqual(await readJson(f.file), f.config);
});
test('restored TOML export is current-model forwarding-only and excludes private authority', () => {
  const model = 'ferry-gpt-6-1-sol-max';
  const snapshot = { runtime: { ready: true, port: 23190, token: 'NEVER_EXPORT_TOKEN' }, profiles: [{
    appId: 'cli_export_fixture', cliId: 'traex', selectedModelId: model, reasoningEffort: 'xhigh',
    larkAppSecret: 'NEVER_EXPORT_SECRET', modelChoices: [{
      id: model, ferryModel: model, efforts: ['medium','xhigh'], contextWindow: 800000,
    }],
  }] };
  const result = forwardingConfiguration(snapshot, 'cli_export_fixture');
  const value = parse(result.content);
  assert.equal(value.model, model);
  assert.equal(value.model_reasoning_effort, 'xhigh');
  assert.equal(value.model_context_window, 800000);
  assert.equal(value.model_providers.botmux_ferry.wire_api, 'responses');
  assert.equal(value.model_providers.botmux_ferry.http_headers['x-botmux-forward-only'], 'true');
  assert.equal(value.model_providers.botmux_ferry.http_headers['x-botmux-app'], undefined);
  assert.doesNotMatch(result.content, /NEVER_EXPORT|cli_export_fixture/);
  assert.equal(result.forwardingOnly, true);
  assert.throws(() => forwardingConfiguration({ ...snapshot, runtime: { ready: false } }, 'cli_export_fixture'), /未就绪/);
  assert.throws(() => forwardingConfiguration(snapshot, 'cli_unknown'), /尚未核验/);
});
