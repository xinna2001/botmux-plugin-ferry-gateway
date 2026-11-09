const architectures = new Set(['codex', 'traex']);
const canonical = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const gptModel = value => typeof value === 'string' && /^ferry-gpt-[a-z0-9-]+$/.test(value);
const supportedEfforts = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'ultra']);

export function architectureOf(bot) {
  return architectures.has(bot.cliId) ? bot.cliId : null;
}

export function modelChoices(bot, ferryModels, nativeCatalog = {}) {
  const architecture = architectureOf(bot);
  if (!architecture || !Array.isArray(ferryModels)) return [];
  const seen = new Set();
  const nativeModels = Array.isArray(nativeCatalog.models) ? nativeCatalog.models : [];
  const capabilities = Array.isArray(nativeCatalog.modelCapabilities) ? nativeCatalog.modelCapabilities : [];
  const choices = [];
  for (const row of ferryModels) {
    if (!gptModel(row.codex) || seen.has(row.codex) || !Number.isInteger(row.context) || row.context <= 0) continue;
    let efforts = Array.isArray(row.efforts) ? row.efforts.filter(value => supportedEfforts.has(value)) : [];
    let clientModel = row.codex;
    let backendVariant;
    let contextWindow = row.context;
    if (architecture === 'traex') {
      if (row.acceleration_supported !== true) continue;
      const match = /^(gpt[^_]+)__(dev|max)$/.exec(row.trae || '');
      if (!match) continue;
      clientModel = nativeModels.find(value => canonical(value) === canonical(match[1]));
      if (!clientModel) continue;
      backendVariant = match[2] === 'max' ? 'max' : 'standard';
      const capability = capabilities.find(value => value.slug === clientModel);
      const variant = capability?.contextVariants?.find(value => value.id === backendVariant);
      if (!variant || !Number.isInteger(variant.contextWindow) || variant.contextWindow <= 0) continue;
      const nativeEfforts = variant.reasoningEfforts ?? capability.reasoningEfforts;
      if (!Array.isArray(nativeEfforts)) continue;
      efforts = efforts.filter(value => nativeEfforts.includes(value));
      contextWindow = Math.min(contextWindow, variant.contextWindow);
    }
    if (!efforts.length) continue;
    seen.add(row.codex);
    choices.push({
      id: row.codex, architecture, clientModel, ferryModel: row.codex,
      backendVariant, contextWindow, efforts,
      label: `${architecture === 'traex' ? `${clientModel}${backendVariant === 'max' ? ' Max' : ''}` : String(row.name || row.codex)} · ${Math.floor(contextWindow / 1000)}K`,
      availableForEffort: efforts.includes(bot.reasoningEffort || 'medium'),
      accelerationAvailable: row.acceleration_supported === true,
    });
  }
  return choices.sort((left, right) => left.id.localeCompare(right.id));
}

export function selectedChoice(bot, choices) {
  return choices.find(choice => choice.architecture === bot.cliId
    && choice.clientModel === bot.model
    && (bot.cliId !== 'traex' || choice.backendVariant === (bot.modelBackendVariant || 'standard'))) ?? null;
}

export function validateModelSelection(bot, choices, id) {
  if (!architectureOf(bot)) throw new Error('当前 Bot 不是已支持的 Codex 或 TraeX 架构');
  if (bot.traexAutoModel?.enabled === true) throw new Error('请先关闭实验性自动选模，再选择固定 GPT 模型');
  const choice = choices.find(value => value.id === id && value.architecture === bot.cliId);
  if (!choice) throw new Error('请选择当前架构明确支持的固定 GPT 模型');
  if (!choice.efforts.includes(bot.reasoningEffort || 'medium')) {
    throw new Error('该 GPT 模型不支持当前推理档位；请先调整档位，不会自动降档');
  }
  return choice;
}

export function modelSelectionPatch(bot, choice) {
  if (choice.architecture !== bot.cliId) throw new Error('Bot 架构已经变化，请刷新后重新选择');
  return {
    model: choice.clientModel,
    ...(bot.cliId === 'traex' ? { modelBackendVariant: choice.backendVariant } : {}),
  };
}
