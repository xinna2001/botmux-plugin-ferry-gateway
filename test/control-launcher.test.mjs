import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'smol-toml';
import { controlLaunchPlan, withoutModelOverrides } from '../gateway/src/lib/control-launcher.mjs';

function fixture(architecture = 'codex') {
  const selection = { ferryModel: 'ferry-gpt-6-1-sol-max',
    clientModel: architecture === 'traex' ? 'GPT-6.1-Sol' : 'ferry-gpt-6-1-sol-max',
    backendVariant: architecture === 'traex' ? 'max' : undefined, contextWindow: 800000, efforts: ['xhigh'] };
  return { bot: { larkAppId: 'cli_fixture', cliId: architecture, model: selection.clientModel,
    modelBackendVariant: selection.backendVariant, reasoningEffort: 'xhigh' },
    binding: { architecture, selection, forwarding: true, acceleration: false,
      native: { command: '/fixture/client', prefixArgs: [] } },
    args: ['exec', '--', 'do not rewrite --model prompt'], env: {},
    runtime: { online: true, port: 18790 }, scopeEnabled: true };
}
function configuration(args) {
  let value = {};
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '-c') value = { ...value, ...parse(args[++index]) };
  }
  return value;
}

test('Codex forwarding works with acceleration off and does not rewrite prompt text', async () => {
  const input = fixture();
  const plan = await controlLaunchPlan(input);
  assert.equal(plan.gateway, true);
  assert.equal(configuration(plan.args).model, input.binding.selection.ferryModel);
  assert.deepEqual(plan.args.slice(plan.args.indexOf('--')), ['--', 'do not rewrite --model prompt']);
});

test('TraeX off remains native while on uses the exact mapped model and native context cap', async () => {
  const input = fixture('traex');
  const native = await controlLaunchPlan(input);
  assert.equal(native.gateway, false);
  assert.deepEqual(native.args, input.args);
  input.binding.acceleration = true;
  const accelerated = await controlLaunchPlan(input);
  const config = configuration(accelerated.args);
  assert.equal(accelerated.gateway, true);
  assert.equal(config.model, 'ferry-gpt-6-1-sol-max');
  assert.equal(config.model_backend_variant, 'standard');
  assert.equal(config.model_context_window, 800000);
  assert.equal(config.model_reasoning_effort, 'xhigh');
});

test('a resumed gateway session retains its provider without forcing current model or effort', async () => {
  const input = fixture();
  input.binding.forwarding = false;
  input.provider = 'botmux_ferry';
  input.args = ['resume', '00000000-0000-4000-8000-000000000001', '-m', 'changed-default', '-c', 'model_reasoning_effort=\"low\"'];
  const result = await controlLaunchPlan(input);
  const config = configuration(result.args);
  assert.equal(result.gateway, true);
  assert.equal(config.model_provider, 'botmux_ferry');
  assert.equal(config.model, undefined);
  assert.equal(config.model_reasoning_effort, undefined);
});

test('native history remains native even when forwarding is currently enabled', async () => {
  const input = fixture();
  input.provider = 'openai';
  input.args = ['resume', '00000000-0000-4000-8000-000000000001', '-m', 'changed-default'];
  const result = await controlLaunchPlan(input);
  assert.equal(result.gateway, false);
  assert.equal(configuration(result.args).model_provider, 'openai');
  assert.equal(configuration(result.args).model, undefined);
});

test('unknown providers, changed models and offline runtimes fail closed', async () => {
  await assert.rejects(controlLaunchPlan({ ...fixture(), provider: 'unrelated' }), /其他 provider/);
  const input = fixture();
  input.bot.model = 'other-model';
  await assert.rejects(controlLaunchPlan(input), /适配记录不一致/);
  await assert.rejects(controlLaunchPlan({ ...fixture(), runtime: { online: false } }), /未就绪/);
});

test('mixed model overrides are not allowed to discard unrelated settings', () => {
  assert.throws(() => withoutModelOverrides(['-c', 'model=\"new\"\ntool_setting=true']), /混合模型/);
  assert.deepEqual(withoutModelOverrides(['-c', 'tool_setting=true', '--', '-m', 'prompt']),
    { before: ['-c', 'tool_setting=true'], after: ['--', '-m', 'prompt'] });
});
