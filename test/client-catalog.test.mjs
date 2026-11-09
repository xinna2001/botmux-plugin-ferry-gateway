import test from 'node:test';
import assert from 'node:assert/strict';
import { boundModelCatalog } from '../gateway/src/lib/client-catalog.mjs';
import { controlLaunchPlan } from '../gateway/src/lib/control-launcher.mjs';

test('client model metadata is limited to verified choices, efforts and context', () => {
  const result = boundModelCatalog({ models: [
    { slug: 'ferry-gpt-test', context_window: 1000000, default_reasoning_level: 'high',
      supported_reasoning_levels: [{ effort: 'high' }, { effort: 'xhigh' }] },
    { slug: 'not-selected' },
  ] }, [{ ferryModel: 'ferry-gpt-test', contextWindow: 800000, efforts: ['xhigh'] }]);
  assert.equal(result.models.length, 1);
  assert.equal(result.models[0].context_window, 800000);
  assert.equal(result.models[0].max_context_window, 800000);
  assert.equal(result.models[0].default_reasoning_level, 'xhigh');
  assert.deepEqual(result.models[0].supported_reasoning_levels, [{ effort: 'xhigh' }]);
  assert.throws(() => boundModelCatalog({ models: [] }, [{ ferryModel: 'missing' }]), /元数据不完整/);
});

test('CLI overrides use unquoted dotted keys accepted by native clients', async () => {
  const plan = await controlLaunchPlan({
    bot: { cliId: 'codex', larkAppId: 'cli_fixture', model: 'ferry-gpt-test' },
    binding: { architecture: 'codex', forwarding: true, modelCatalog: '/fixture/models.json',
      native: { command: 'codex', prefixArgs: [] },
      selection: { clientModel: 'ferry-gpt-test', ferryModel: 'ferry-gpt-test', efforts: ['medium'] } },
    args: ['app-server'], env: {}, scopeEnabled: true, runtime: { online: true, port: 19879 },
  });
  assert.ok(plan.args.includes('model_provider="botmux_ferry"'));
  assert.ok(plan.args.includes('model_catalog_json="/fixture/models.json"'));
  assert.ok(plan.args.includes('model_providers.botmux_ferry.wire_api="responses"'));
  assert.ok(plan.args.every(value => !value.startsWith('"model')));
});
