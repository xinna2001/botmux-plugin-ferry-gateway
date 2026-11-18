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
  const merge = (target, patch) => {
    for (const [key, item] of Object.entries(patch)) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        target[key] ||= {};
        merge(target[key], item);
      } else target[key] = item;
    }
  };
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '-c') merge(value, parse(args[++index]));
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
test('a help-like prompt after the option boundary is not a utility or native-routing bypass', async () => {
  const input = fixture();
  input.args = ['exec', '--', '--help'];
  const plan = await controlLaunchPlan(input);
  assert.equal(plan.gateway, true);
  assert.deepEqual(plan.args.slice(plan.args.indexOf('--')), ['--', '--help']);
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

test('a resumed gateway session restores successful model and effort instead of current defaults', async () => {
  const input = fixture();
  input.binding.forwarding = false;
  input.provider = 'botmux_ferry';
  input.history = { provider: 'botmux_ferry', model: 'ferry-gpt-6-1-sol-max', effort: 'xhigh' };
  input.args = ['resume', '00000000-0000-4000-8000-000000000001', '-m', 'changed-default', '-c', 'model_reasoning_effort=\"low\"'];
  const result = await controlLaunchPlan(input);
  const config = configuration(result.args);
  assert.equal(result.gateway, true);
  assert.equal(config.model_provider, 'botmux_ferry');
  assert.equal(config.model, 'ferry-gpt-6-1-sol-max');
  assert.equal(config.model_reasoning_effort, 'xhigh');
  assert.equal(config.model_providers.botmux_ferry.wire_api, 'responses');
});

test('native history remains native even when forwarding is currently enabled', async () => {
  const input = fixture();
  input.provider = 'openai';
  input.history = { provider: 'openai', model: 'gpt-6.1-sol', effort: 'high' };
  input.args = ['resume', '00000000-0000-4000-8000-000000000001', '-m', 'changed-default'];
  const result = await controlLaunchPlan(input);
  assert.equal(result.gateway, false);
  assert.equal(configuration(result.args).model_provider, 'openai');
  assert.equal(configuration(result.args).model, 'gpt-6.1-sol');
  assert.equal(configuration(result.args).model_reasoning_effort, 'high');
});

test('resumed copies send the verified current native ID, not the inherited prompt cache identity', async () => {
  const id = '00000000-0000-4000-8000-000000000041';
  for (const cli of ['traex', 'codex']) {
    const input = fixture(cli);
    input.history = { provider: 'botmux_ferry', model: input.binding.selection.ferryModel, effort: 'xhigh' };
    input.args = ['resume', id];
    const plan = await controlLaunchPlan(input);
    assert.equal(configuration(plan.args).model_providers.botmux_ferry.http_headers['x-botmux-native-session'], id);
    input.args = ['fork', id];
    assert.equal(configuration((await controlLaunchPlan(input)).args).model_providers.botmux_ferry.http_headers['x-botmux-native-session'],
      undefined, 'a new fork must not be labeled with its parent native ID');
    input.history = undefined;
    input.binding.acceleration = true;
    input.args = [];
    assert.equal(configuration((await controlLaunchPlan(input)).args).model_providers.botmux_ferry.http_headers['x-botmux-native-session'],
      undefined, 'a fresh CLI has not yet allocated its native ID');
  }
});

test('successful history wins over stale topic provider, model and effort', async () => {
  const input = fixture('traex');
  input.bot.model = 'GPT-OTHER';
  input.bot.reasoningEffort = 'low';
  input.provider = 'trae';
  input.pinned = true;
  input.history = { provider: 'botmux_ferry', model: 'ferry-gpt-6-1-sol-max', effort: 'xhigh' };
  input.args = ['resume', '00000000-0000-4000-8000-000000000001'];
  const result = await controlLaunchPlan(input);
  assert.equal(result.gateway, true);
  const config = configuration(result.args);
  assert.equal(config.model_provider, 'botmux_ferry');
  assert.equal(config.model, input.history.model);
  assert.equal(config.model_reasoning_effort, 'xhigh');
  assert.equal(config.model_context_window, 800000);
});

test('provider-only resumes and incomplete FERRY history never use default models', async () => {
  const input = fixture();
  input.args = ['resume', '00000000-0000-4000-8000-000000000001'];
  input.provider = 'botmux_ferry';
  await assert.rejects(controlLaunchPlan(input), /完整且已核验/);
  input.history = { provider: 'botmux_ferry', model: 'ferry-gpt-6-1-sol-max' };
  await assert.rejects(controlLaunchPlan(input), /无法核验/);
});

test('a historical model no longer in the current binding is passed exactly without substitution', async () => {
  const input = fixture('traex');
  input.history = { provider: 'botmux_ferry', model: 'ferry-gpt-6-astra-max', effort: 'high' };
  input.args = ['exec', 'resume', '00000000-0000-4000-8000-000000000001'];
  const plan = await controlLaunchPlan(input);
  const config = configuration(plan.args);
  assert.equal(config.model, 'ferry-gpt-6-astra-max');
  assert.equal(config.model_reasoning_effort, 'high');
  assert.equal(config.model_context_window, undefined);
});

test('unknown providers, changed models and offline runtimes fail closed', async () => {
  await assert.rejects(controlLaunchPlan({ ...fixture(), provider: 'unrelated' }), /其他 provider/);
  const input = fixture();
  input.bot.model = 'other-model';
  await assert.rejects(controlLaunchPlan(input), /已核验的映射/);
  await assert.rejects(controlLaunchPlan({ ...fixture(), runtime: { online: false } }), /未就绪/);
});

test('mixed model overrides are not allowed to discard unrelated settings', () => {
  assert.throws(() => withoutModelOverrides(['-c', 'model=\"new\"\ntool_setting=true']), /混合模型/);
  assert.deepEqual(withoutModelOverrides(['-c', 'tool_setting=true', '--', '-m', 'prompt']),
    { before: ['-c', 'tool_setting=true'], after: ['--', '-m', 'prompt'] });
});
