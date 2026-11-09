import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJson, digest, getBot, homePath, pluginConfig, readJson, withLock } from '../../../shared/state.mjs';
import { architectureOf, modelChoices, selectedChoice, validateModelSelection, modelSelectionPatch } from './model-catalog.mjs';
import { hostRequest, nativeModelCatalog, patchBot, rollbackBot, reloadBot,
  managementAuthority, assertManagementAuthority } from './host-control.mjs';
import { prepareClientBinding, bindingPatch } from './client-binding.mjs';
import { prepareClientCatalog } from './client-catalog.mjs';
import { managedRuntimeStatus, gatewayModels, ensureManagedRuntime } from './managed-runtime.mjs';
import { runtimeStatus } from './runtime.mjs';
import { setupStatus } from './setup.mjs';
import { supportedRuntime } from './runtime-instrument.mjs';

const id = 'gateway-acceleration';
const catalogCache = new Map();
const nameCache = new Map();
const profileId = (bot, config) => config.profiles?.find(profile => profile.appId === bot.larkAppId)?.id
  || `bot-${digest(bot.larkAppId).slice(0, 16)}`;
const enabled = (bot, global, registry) => !!registry.plugins?.[id]
  && (bot.plugins?.includes(id) === true || global.plugins?.includes(id) === true);

async function botNames(home, deps) {
  const cached = nameCache.get(home);
  if (cached && Date.now() - cached.at < 60000) return cached.value;
  try {
    const response = await (deps.request || hostRequest)(home, '/api/plugins');
    const value = Object.fromEntries((response.bots || [])
      .filter(bot => typeof bot.name === 'string').map(bot => [bot.id || bot.appId, bot.name]));
    if (nameCache.size > 100) nameCache.clear();
    nameCache.set(home, { value, at: Date.now() });
    return value;
  } catch { return {}; }
}

async function catalogFor(bot, home, deps) {
  if (bot.cliId !== 'traex') return {};
  const key = `${home}:${digest({ appId: bot.larkAppId, cliId: bot.cliId,
    executable: bot.cliRuntime?.executable || bot.cliPathOverride, model: bot.model, variant: bot.modelBackendVariant })}`;
  const cached = catalogCache.get(key);
  if (!deps.refresh && cached && Date.now() - cached.at < 60000) return cached.value;
  const value = await (deps.nativeModelCatalog || nativeModelCatalog)(bot, home, deps);
  if (catalogCache.size > 100) catalogCache.clear();
  catalogCache.set(key, { at: Date.now(), value });
  return value;
}

function eligibility(bot, binding, selection, scope, runtime) {
  if (!scope) return { eligible: false, code: 'scope', reason: '请先为此 Bot 启用插件' };
  if (!architectureOf(bot)) return { eligible: false, code: 'cli', reason: '当前只适配 Codex 和 TraeX' };
  if (bot.model === 'auto' || bot.traexAutoModel?.enabled === true) return { eligible: false, code: 'auto', reason: '请先关闭实验性自动选模，选择固定 GPT 模型' };
  if (!binding || !selection) return { eligible: false, code: 'model', reason: '请先选择此架构的 GPT 模型，自动建立适配' };
  if (!runtime.online) return { eligible: false, code: 'offline', reason: 'FERRY 受管运行时尚未就绪' };
  if (!selection.efforts.includes(bot.reasoningEffort || 'medium')) return { eligible: false, code: 'effort', reason: '当前模型不支持所选档位，不会自动降档' };
  if (!selection.accelerationAvailable) return { eligible: false, code: 'unsupported', reason: '当前环境未确认此 GPT 模型的同模型加速能力' };
  if (bot.cliId === 'codex' && binding.forwarding !== true) return { eligible: false, code: 'forwarding', reason: '请先开启模型转发，再开启同模型加速' };
  return { eligible: true, code: 'ready', reason: '架构、模型和档位已核验；加速仍可能排队' };
}

export async function controlStatus(home = homePath(), deps = {}) {
  const [config, bots, global, registry, runtime] = await Promise.all([
    readJson(pluginConfig(id, home)), readJson(join(home, 'bots.json'), []),
    readJson(join(home, 'config.json')), readJson(join(home, 'plugins-registry.json')),
    (deps.managedRuntimeStatus || managedRuntimeStatus)(home, deps),
  ]);
  if (!Array.isArray(bots) || bots.length > 500) throw new Error('Bot 配置列表无效');
  const [models, names] = await Promise.all([(deps.gatewayModels || gatewayModels)(home, deps), botNames(home, deps)]);
  const profiles = await Promise.all(bots.filter(bot => architectureOf(bot)).map(async bot => {
    const scope = enabled(bot, global, registry);
    let native = {};
    let catalogError;
    if (scope) {
      try { native = await catalogFor(bot, home, deps); }
      catch { catalogError = '对应架构的模型目录暂不可用，未提供猜测选项'; }
    }
    const choices = scope ? modelChoices(bot, models, native) : [];
    if (scope && !choices.length && !catalogError) catalogError = '当前架构与环境没有已核验的可用 GPT 模型';
    const binding = config.controlPlane?.bots?.[bot.larkAppId];
    const selected = binding && selectedChoice(bot, choices);
    const selection = selected?.id === binding?.selection?.id ? selected : null;
    const compatible = eligibility(bot, binding, selection, scope, runtime);
    return {
      id: profileId(bot, config), appId: bot.larkAppId,
      name: names[bot.larkAppId] || bot.name || bot.botName
        || config.profiles?.find(value => value.appId === bot.larkAppId)?.name || bot.larkAppId,
      cliId: bot.cliId, model: bot.model || '', modelLabel: selectedChoice(bot, choices)?.label || bot.model || '未选择模型',
      reasoningEffort: bot.reasoningEffort || 'medium', backendVariant: bot.modelBackendVariant,
      configured: true, pluginEnabled: scope, adopted: !!binding,
      selectedModelId: selection?.id || '', modelChoices: choices, catalogError,
      autoModel: bot.model === 'auto' || bot.traexAutoModel?.enabled === true,
      automaticPoolEnabled: bot.traexAutoModel?.enabled === true,
      enabled: binding?.acceleration === true,
      controlAvailable: !!binding,
      compatibility: compatible,
      connection: { enabled: bot.cliId === 'codex' ? binding?.forwarding === true : binding?.acceleration === true,
        controlAvailable: bot.cliId === 'codex' && !!binding, verified: !!binding,
        online: runtime.online, ready: !!binding && runtime.online,
        reason: binding ? '使用独立转发控制；旧会话保留原线路' : '选择 GPT 模型后自动接入' },
      health: { online: runtime.online }, requests: [],
      revision: digest({ config, bot, choices, runtime: { online: runtime.online, port: runtime.port, pid: runtime.pid } }),
      configHash: digest(config), botHash: digest(bot),
    };
  }));
  return { schemaVersion: 3, observedAt: Date.now(), profiles, runtime };
}

export async function controlSettings(home = homePath(), deps = {}) {
  const [snapshot, node, setup] = await Promise.all([
    controlStatus(home, deps), (deps.runtimeStatus || runtimeStatus)(home, deps),
    (deps.setupStatus || setupStatus)(home, deps),
  ]);
  return {
    ...snapshot, setup: { ...setup, compatible: setup.adapterCompatible === true,
      requiredVersion: supportedRuntime.version, runtime: node },
    configRevision: digest(await readJson(pluginConfig(id, home))),
  };
}

async function currentProfile(input, home, deps) {
  const snapshot = await controlStatus(home, { ...deps, refresh: true });
  const profile = snapshot.profiles.find(value => value.id === input.profileId);
  if (!profile || profile.revision !== input.revision) throw new Error('配置或模型目录已变化，请刷新后重试');
  return profile;
}

export async function initializeControlRuntime(home = homePath(), deps = {}) {
  const ready = await (deps.ensureManagedRuntime || ensureManagedRuntime)(home, deps);
  await withLock(pluginConfig(id, home), async () => {
    const config = await readJson(pluginConfig(id, home));
    config.controlPlane = { ...config.controlPlane, schemaVersion: 1, runtimeWanted: true,
      bots: config.controlPlane?.bots || {} };
    await atomicJson(pluginConfig(id, home), config);
  });
  return ready;
}

export async function selectControlModel(input, home = homePath(), deps = {}) {
  const authority = await managementAuthority(home);
  return withLock(pluginConfig(id, home), async () => {
    const profile = await currentProfile(input, home, deps);
    if (!profile.pluginEnabled) throw new Error('请先为此 Bot 启用插件');
    if (!profile.health.online) throw new Error('请先完成 FERRY 首次配置');
    const bot = await getBot(profile.appId, home);
    const config = await readJson(pluginConfig(id, home));
    const previous = structuredClone(config);
    const existing = config.controlPlane?.bots?.[bot.larkAppId];
    if (existing?.acceleration === true) throw new Error('请先关闭同模型加速，再更换模型');
    const choice = validateModelSelection(bot, profile.modelChoices, input.modelId);
    const legacy = config.profiles?.find(value => value.appId === bot.larkAppId);
    if (existing && bot.cliPathOverride !== existing.launcher && bot.cliRuntime?.executable !== existing.launcher) {
      throw new Error('客户端启动入口已被外部修改，未自动覆盖');
    }
    const binding = existing ? structuredClone(existing)
      : await (deps.prepareClientBinding || prepareClientBinding)(bot, legacy, home, deps);
    binding.modelCatalog = await (deps.prepareClientCatalog || prepareClientCatalog)(bot, profile.modelChoices,
      home, await (deps.managedRuntimeStatus || managedRuntimeStatus)(home, deps), deps);
    if (digest(await readFile(binding.launcher, 'utf8')) !== binding.launcherHash) throw new Error('FERRY 启动器内容已变化');
    Object.assign(binding, { selection: choice, acceleration: false, forwarding: bot.cliId === 'codex' });
    config.controlPlane = { ...config.controlPlane, schemaVersion: 1, runtimeWanted: true,
      bots: { ...config.controlPlane?.bots, [bot.larkAppId]: binding } };
    await assertManagementAuthority(home, authority);
    await atomicJson(pluginConfig(id, home), config);
    let transaction;
    try {
      transaction = await patchBot(home, bot.larkAppId, profile.botHash, {
        ...modelSelectionPatch(bot, choice), ...bindingPatch(bot, binding),
      }, authority);
      await assertManagementAuthority(home, authority);
      await (deps.reloadBot || reloadBot)(home, transaction.next, deps);
      const saved = await getBot(bot.larkAppId, home);
      if (transaction.fields.some(field => JSON.stringify(saved[field]) !== JSON.stringify(transaction.next[field]))) {
        throw new Error('宿主读回配置与选择不一致');
      }
    } catch (error) {
      if (transaction) {
        const restored = await rollbackBot(home, transaction);
        if (!restored) throw new Error('配置已被并发修改，未覆盖新配置；适配记录已保留，请检查宿主 Bot 设置');
        await atomicJson(pluginConfig(id, home), previous);
        try {
          await assertManagementAuthority(home, authority);
          await (deps.reloadBot || reloadBot)(home, transaction.previous, deps);
        } catch {
          throw new Error('配置文件已回滚，但宿主内存状态尚未确认；请在宿主 Bot 设置中重新保存原配置', { cause: error });
        }
      } else {
        await atomicJson(pluginConfig(id, home), previous);
      }
      throw error;
    }
    return controlStatus(home, deps);
  });
}

export async function setControl(input, home = homePath(), deps = {}) {
  if (!['forwarding', 'acceleration'].includes(input.action) || typeof input.enabled !== 'boolean') throw new Error('操作参数无效');
  const authority = await managementAuthority(home);
  return withLock(pluginConfig(id, home), async () => {
    const profile = await currentProfile(input, home, deps);
    const config = await readJson(pluginConfig(id, home));
    const binding = config.controlPlane?.bots?.[profile.appId];
    if (!binding) throw new Error('请先选择 GPT 模型完成真实适配');
    if (input.action === 'forwarding' && profile.cliId !== 'codex') throw new Error('TraeX 不提供独立模型转发开关');
    if (input.enabled && !profile.pluginEnabled) throw new Error('请先为此 Bot 启用插件');
    if (input.enabled && !profile.health.online) throw new Error('FERRY 运行时尚未就绪');
    if (input.enabled && (!profile.selectedModelId || profile.autoModel)) throw new Error('请先选择已核验的固定 GPT 模型');
    if (input.action === 'acceleration' && input.enabled && !profile.compatibility.eligible) {
      throw new Error(profile.compatibility.reason);
    }
    if (input.action === 'forwarding' && !input.enabled && binding.acceleration === true) {
      throw new Error('请先关闭同模型加速；不会联动修改另一个开关');
    }
    binding[input.action] = input.enabled;
    await assertManagementAuthority(home, authority);
    await atomicJson(pluginConfig(id, home), config);
    return controlStatus(home, deps);
  });
}
