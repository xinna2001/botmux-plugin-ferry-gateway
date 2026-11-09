import { join } from 'node:path';
import { atomicJson, digest, validateAppId } from '../../../shared/state.mjs';

export function boundModelCatalog(catalog, choices) {
  if (!Array.isArray(catalog?.models)) throw new Error('FERRY 客户端模型目录格式无效');
  const models = choices.map(choice => {
    const model = catalog.models.find(item => item.slug === choice.ferryModel);
    if (!model || !Array.isArray(model.supported_reasoning_levels)) throw new Error('FERRY 客户端模型元数据不完整');
    const levels = model.supported_reasoning_levels.filter(level => choice.efforts.includes(level.effort));
    if (!levels.length) throw new Error('FERRY 客户端推理档位不一致');
    return { ...model, visibility: 'list', context_window: choice.contextWindow,
      max_context_window: choice.contextWindow, supported_reasoning_levels: levels,
      default_reasoning_level: levels.some(level => level.effort === model.default_reasoning_level)
        ? model.default_reasoning_level : levels[0].effort };
  });
  return { models };
}

export async function prepareClientCatalog(bot, choices, home, runtime, deps = {}) {
  validateAppId(bot.larkAppId);
  if (!runtime?.online || !Number.isInteger(runtime.port) || runtime.port < 1024 || runtime.port > 65535) {
    throw new Error('FERRY 运行时尚未就绪');
  }
  const response = await (deps.fetcher || fetch)(`http://127.0.0.1:${runtime.port}/v1/models`, {
    headers: { 'x-ferry-client': 'traex' }, redirect: 'error', signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('FERRY 客户端模型目录暂不可用');
  const catalog = boundModelCatalog(await response.json(), choices);
  const file = join(home, 'plugins/gateway-acceleration/private/clients', bot.larkAppId,
    `models-${digest(catalog).slice(0, 24)}.json`);
  await atomicJson(file, catalog);
  return file;
}
