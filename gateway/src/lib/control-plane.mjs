import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJson, digest, getBot, homePath, pluginConfig, readJson, withLock } from '../../../shared/state.mjs';
import { architectureOf, modelChoices, selectedChoice, configuredModelChoice } from './model-catalog.mjs';
import { hostRequest, nativeModelCatalog, patchBot, rollbackBot, reloadBot,
  managementAuthority, assertManagementAuthority } from './host-control.mjs';
import { prepareClientBinding, bindingPatch } from './client-binding.mjs';
import { prepareClientCatalog } from './client-catalog.mjs';
import { managedRuntimeStatus, gatewayModels } from './managed-runtime.mjs';
import { legacyStatus } from './gateway.mjs';
import { preparationStatus } from './onboarding.mjs';
import { prepareLegacyBridge, applyLegacyBridge, restoreLegacyBridge } from './legacy-bridge.mjs';
import { defaultBinding, defaultScope } from './topic-state.mjs';
import { cachedPreparationStatus } from './preparation-cache.mjs';
import { getJobStatus } from './setup.mjs';
import { versionCheckStatus } from './version-check.mjs';
import { setLiveAcceleration } from './live-control.mjs';
import { setRoutingIntent, routingStatus, routingProjection } from './routing-transitions.mjs';

const id = 'gateway-acceleration';
const catalogCache = new Map();
const catalogPending = new Map();
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
  const key = `${home}:${bot.cliId}`;
  const cached = catalogCache.get(key);
  if (!deps.refresh && cached && Date.now() - cached.at < 60000) return cached.value;
  if (catalogPending.has(key)) return catalogPending.get(key);
  const pending = Promise.resolve().then(() => (deps.nativeModelCatalog || nativeModelCatalog)(bot, home, deps));
  catalogPending.set(key, pending);
  try {
    const value = await pending;
    if (catalogCache.size > 100) catalogCache.clear();
    catalogCache.set(key, { at: Date.now(), value });
    return value;
  } finally { catalogPending.delete(key); }
}

function eligibility(bot, binding, selection, scope, runtime) {
  if (!scope) return { eligible: false, code: 'scope', reason: '请先为此 Bot 启用插件' };
  if (!architectureOf(bot)) return { eligible: false, code: 'cli', reason: '当前只适配 Codex 和 TraeX' };
  if (bot.model === 'auto' || bot.traexAutoModel?.enabled === true) return { eligible: false, code: 'auto', reason: '请先关闭实验性自动选模，选择固定 GPT 模型' };
  if (!binding || !selection) return { eligible: false, code: 'model', reason: '请先选择此架构的 GPT 模型，自动建立适配' };
  if (runtime.ready !== true) return { eligible: false, code: 'offline',
    reason: runtime.online ? '实际网关的登录依赖、认证或模型目录尚未就绪' : '请先启动网关' };
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
  const routing = await routingStatus(home);
  const [models, names] = await Promise.all([(deps.gatewayModels || gatewayModels)(home, deps), botNames(home, deps)]);
  let legacyProfiles = new Map();
  if (config.profiles?.some(profile => !config.controlPlane?.bots?.[profile.appId])) {
    try {
      const legacy = await (deps.legacyStatus || legacyStatus)(home, deps.fetcher || fetch);
      legacyProfiles = new Map(legacy.profiles.map(profile => [profile.appId, profile]));
    } catch {}
  }
  const profiles = await Promise.all(bots.map(async bot => {
    const nativeScope = enabled(bot, global, registry);
    const scope = nativeScope && defaultScope(config, bot.larkAppId, nativeScope);
    let native = {};
    let catalogError;
    try { if (models.length && architectureOf(bot)) native = await catalogFor(bot, home, deps); }
    catch { catalogError = '对应架构的模型目录暂不可用，未提供猜测选项'; }
    const choices = modelChoices(bot, models, native);
    if (!choices.length && !catalogError) catalogError = '当前架构与环境没有已核验的可用 GPT 模型';
    const binding = defaultBinding(config, bot.larkAppId);
    const legacyConfig = config.profiles?.find(profile => profile.appId === bot.larkAppId);
    const legacy = !binding && legacyProfiles.get(bot.larkAppId);
    const selection = selectedChoice(bot, choices);
    const acceleration = binding ? binding.acceleration === true : legacyConfig
      ? legacy?.connection?.verified === true && typeof legacy.enabled === 'boolean' ? legacy.enabled : null
      : false;
    const legacyControl = legacy?.controlAvailable === true && legacy.connection?.verified === true;
    const forwarding = binding ? bot.cliId === 'codex' ? binding.forwarding === true : binding.acceleration === true
      : legacy?.connection?.verified === true && legacy.connection.enabled === true;
    const canBind = !!selection && selection.availableForEffort && runtime.ready === true
      && bot.model !== 'auto' && bot.traexAutoModel?.enabled !== true
      && (!legacyConfig || !!binding || legacy?.connection?.verified === true);
    const readiness = eligibility(bot, binding || { forwarding }, selection, true, runtime);
    return {
      id: profileId(bot, config), appId: bot.larkAppId,
      name: names[bot.larkAppId] || bot.name || bot.botName
        || config.profiles?.find(value => value.appId === bot.larkAppId)?.name || bot.larkAppId,
      cliId: bot.cliId, model: bot.model || '', modelLabel: selectedChoice(bot, choices)?.label || bot.model || '未选择模型',
      reasoningEffort: bot.reasoningEffort || 'medium', backendVariant: bot.modelBackendVariant,
      configured: true, pluginEnabled: scope, nativePluginEnabled: enabled(bot, global, registry), adopted: !!binding,
      liveControl: { enabled: nativeScope && config.liveControls?.bots?.[bot.larkAppId]?.enabled !== false,
        revision: config.liveControls?.bots?.[bot.larkAppId]?.revision || 0, protocol: runtime.controlProtocol || 0 },
      routingTransition: routingProjection(config, routing, bot.larkAppId),
      priorRouting: { acceleration, forwarding },
      controlMode: binding ? 'managed' : legacyConfig ? legacyControl ? 'legacy-independent' : 'legacy-readonly' : 'unconfigured',
      controlRuntimeOnline: runtime.ready === true,
      selectedModelId: selection?.id || '', modelChoices: choices, catalogError,
      autoModel: bot.model === 'auto' || bot.traexAutoModel?.enabled === true,
      automaticPoolEnabled: bot.traexAutoModel?.enabled === true,
      enabled: scope && acceleration,
      controlAvailable: (!!binding && acceleration === true) || canBind || legacyControl,
      canEnableForwarding: bot.cliId === 'codex' && canBind,
      canEnableAcceleration: canBind && selection.accelerationAvailable
        && (bot.cliId !== 'codex' || forwarding),
      legacyIndependent: legacyControl,
      compatibility: !binding && legacyControl && !runtime.online ? legacy.compatibility
        : !binding && legacyConfig && !legacy ? { eligible: false, code: 'legacy-unknown', reason: '现有线路暂不可核验，请刷新后重试' } : readiness,
      connection: { enabled: scope && forwarding,
        controlAvailable: bot.cliId === 'codex' && ((!!binding && forwarding) || canBind), verified: !!binding || legacy?.connection?.verified === true,
        online: binding ? runtime.online : legacy?.health?.online === true, ready: !!binding && runtime.ready === true,
        reason: !selection || bot.model === 'auto' || bot.traexAutoModel?.enabled
          ? '当前模型不是已核验的固定 GPT 模型，不能开启；已开启的仍可关闭'
          : binding ? '关闭转发会同时关闭加速；已有会话保留原 provider'
          : legacyConfig ? '首次操作会接入通用控制，保留旧会话入口'
            : '开启时自动接入当前 Bot 模型，不修改模型或推理档位' },
      health: { online: binding ? runtime.online : legacy?.health?.online === true,
        version: binding ? runtime.upstreamVersion || runtime.version : legacy?.health?.version,
        state: binding ? runtime.online ? 'online' : 'offline'
          : legacy ? legacy.health.online ? 'online' : 'offline' : legacyConfig ? 'unknown' : 'unconfigured' },
      requests: [],
      revision: digest({ config, bot, choices, legacyRevision: legacy?.revision, acceleration,
        runtime: { online: runtime.online, ready: runtime.ready, port: runtime.port, pid: runtime.pid } }),
      configHash: digest(config), botHash: digest(bot),
    };
  }));
  return { schemaVersion: 4, observedAt: Date.now(), profiles, runtime,
    scopeRevision: config.topicDefaults?.revision || 0,
    defaults: { globalEnabled: config.topicDefaults?.globalEnabled === true },
    configRevision: digest(config) };
}

export async function controlSettings(home = homePath(), deps = {}) {
  const snapshot = await controlStatus(home, deps);
  const setup = await cachedPreparationStatus(home, deps, snapshot.runtime);
  return {
    ...snapshot, setup,
    backendVersion: typeof __FERRY_PLUGIN_VERSION__ === 'undefined' ? 'development' : __FERRY_PLUGIN_VERSION__,
    versionCheck: await versionCheckStatus(home),
  };
}

// Scope and job reads must not discover Node/npm, fetch model catalogs or probe
// SSO. This is also the cross-page reconciliation and update-progress endpoint.
export async function controlState(home = homePath()) {
  const [config, bots, global, registry, job, versionCheck] = await Promise.all([
    readJson(pluginConfig(id, home)), readJson(join(home, 'bots.json'), []),
    readJson(join(home, 'config.json')), readJson(join(home, 'plugins-registry.json')),
    getJobStatus(home), versionCheckStatus(home),
  ]);
  if (!Array.isArray(bots) || bots.length > 500) throw new Error('Bot 配置列表无效');
  const routing = await routingStatus(home);
  const names = nameCache.get(home)?.value || {};
  return { scopeOnly: true, observedAt: Date.now(),
    backendVersion: typeof __FERRY_PLUGIN_VERSION__ === 'undefined' ? 'development' : __FERRY_PLUGIN_VERSION__,
    scopeRevision: config.topicDefaults?.revision || 0, configRevision: digest(config),
    defaults: { globalEnabled: config.topicDefaults?.globalEnabled === true },
    setup: { job }, versionCheck,
    profiles: bots.map(bot => {
      const nativeScope = enabled(bot, global, registry);
      const scope = nativeScope && defaultScope(config, bot.larkAppId, nativeScope);
      const binding = defaultBinding(config, bot.larkAppId);
      return { appId: bot.larkAppId, id: profileId(bot, config), cliId: bot.cliId, model: bot.model,
        name: names[bot.larkAppId] || bot.name || bot.botName
          || config.profiles?.find(value => value.appId === bot.larkAppId)?.name || bot.larkAppId,
        reasoningEffort: bot.reasoningEffort || 'medium', backendVariant: bot.modelBackendVariant,
        liveControl: { enabled: nativeScope && config.liveControls?.bots?.[bot.larkAppId]?.enabled !== false,
          revision: config.liveControls?.bots?.[bot.larkAppId]?.revision || 0 },
        routingTransition: routingProjection(config, routing, bot.larkAppId),
        pluginEnabled: scope, nativePluginEnabled: enabled(bot, global, registry), enabled: scope && binding?.acceleration === true,
        connection: { enabled: scope && (bot.cliId === 'codex' ? binding?.forwarding === true : binding?.acceleration === true) } };
    }) };
}

async function disableDefaults(input, home) {
  const authority = await managementAuthority(home);
  await withLock(pluginConfig(id, home), async () => {
    const [config, bots, global, registry] = await Promise.all([
      readJson(pluginConfig(id, home)), readJson(join(home, 'bots.json'), []),
      readJson(join(home, 'config.json')), readJson(join(home, 'plugins-registry.json')),
    ]);
    if (!Array.isArray(bots) || bots.length > 500) throw new Error('Bot 配置列表无效');
    const targets = input.appId === 'global' ? bots : bots.filter(bot =>
      input.appId ? bot.larkAppId === input.appId : profileId(bot, config) === input.profileId);
    if (!targets.length) throw new Error('请选择有效的 Bot');
    const defaults = { ...config.topicDefaults, schemaVersion: 1,
      scopes: { ...config.topicDefaults?.scopes }, bindings: { ...config.topicDefaults?.bindings } };
    if (defaults.globalEnabled === true && input.action === 'master') {
      // Turning off one Bot while all-on is active preserves the effective
      // state of every other Bot, rather than silently overriding the off.
      for (const bot of bots) defaults.scopes[bot.larkAppId] =
        defaultScope(config, bot.larkAppId, enabled(bot, global, registry));
      defaults.globalEnabled = false;
    }
    for (const bot of targets) {
      if (input.action === 'forwarding' && bot.cliId !== 'codex') throw new Error('TraeX 不提供独立模型转发开关');
      const binding = defaultBinding(config, bot.larkAppId);
      if (input.action === 'master' || !binding) defaults.scopes[bot.larkAppId] = false;
      if (binding) {
        const next = structuredClone(binding);
        if (input.action === 'master') { next.forwarding = false; next.acceleration = false; }
        else { next[input.action] = false; if (input.action === 'forwarding') next.acceleration = false; }
        defaults.bindings[bot.larkAppId] = next;
      }
      setLiveAcceleration(config, bot.larkAppId, false);
      if (bot.cliId === 'traex' || ['master', 'forwarding'].includes(input.action)) {
        setRoutingIntent(config, bot.larkAppId, 'native', authority);
      }
    }
    defaults.revision = (config.topicDefaults?.revision || 0) + 1;
    await assertManagementAuthority(home, authority);
    config.topicDefaults = defaults;
    await atomicJson(pluginConfig(id, home), config);
  });
  return controlState(home);
}

export async function setDefaultScope(input, home = homePath(), deps = {}) {
  return withLock(join(home, 'plugins/gateway-acceleration/private/default-operation'),
    () => setDefaultScopeLocked(input, home, { ...deps, defaultTransaction: true }));
}
async function setDefaultScopeLocked(input, home, deps) {
  if (typeof input.enabled !== 'boolean') throw new Error('操作参数无效');
  if (!input.enabled) return disableDefaults({ ...input, action: 'master' }, home);
  const authority = await managementAuthority(home);
  const snapshot = await controlStatus(home, deps);
  const targets = input.appId === 'global' ? snapshot.profiles
    : snapshot.profiles.filter(profile => profile.appId === input.appId);
  if (!targets.length) throw new Error('请选择有效的 Bot');
  const previousConfig = await readJson(pluginConfig(id, home));
  const before = previousConfig.topicDefaults;
  const previousLive = previousConfig.liveControls;
  const previousRouting = previousConfig.routingIntents;
  // Validate every target before creating any binding.
  if (input.enabled && targets.some(profile => !profile.canEnableAcceleration
    && !(profile.cliId === 'codex' && profile.canEnableForwarding && profile.modelChoices.some(c => c.accelerationAvailable)))) {
    throw new Error('当前有 Bot 的模型、档位或网关尚未核验，未开启全部 Bot');
  }
  try {
    for (const target of targets) {
      const profile = (await controlStatus(home, deps)).profiles.find(p => p.appId === target.appId);
      await setControl({ action: 'master', enabled: input.enabled, profileId: profile.id, revision: profile.revision },
        home, { ...deps, deferLiveControls: true });
    }
    await withLock(pluginConfig(id, home), async () => {
      const config = await readJson(pluginConfig(id, home));
      await assertManagementAuthority(home, authority);
      if (input.appId === 'global') config.topicDefaults = { ...config.topicDefaults, globalEnabled: input.enabled,
        revision: (config.topicDefaults?.revision || 0) + 1 };
      for (const target of targets) {
        setLiveAcceleration(config, target.appId, true);
        setRoutingIntent(config, target.appId, 'gateway', authority);
      }
      await atomicJson(pluginConfig(id, home), config);
    });
  } catch (error) {
    // Restore only this operation's defaults; original routes never change.
    await withLock(pluginConfig(id, home), async () => {
      const config = await readJson(pluginConfig(id, home));
      config.topicDefaults = { ...before, revision: Math.max(config.topicDefaults?.revision || 0, before?.revision || 0) + 1 };
      if (previousLive === undefined) delete config.liveControls;
      else config.liveControls = previousLive;
      if (previousRouting === undefined) delete config.routingIntents;
      else config.routingIntents = previousRouting;
      await atomicJson(pluginConfig(id, home), config);
    });
    throw error;
  }
  return controlSettings(home, deps);
}

async function currentProfile(input, home, deps) {
  const snapshot = await controlStatus(home, { ...deps, refresh: true });
  const profile = snapshot.profiles.find(value => value.id === input.profileId);
  if (!profile || profile.revision !== input.revision) throw new Error('配置或模型目录已变化，请刷新后重试');
  return profile;
}

export async function setControl(input, home = homePath(), deps = {}) {
  if (!deps.defaultTransaction) return withLock(join(home, 'plugins/gateway-acceleration/private/default-operation'),
    () => setControl(input, home, { ...deps, defaultTransaction: true }));
  if (!['forwarding', 'acceleration', 'master'].includes(input.action) || typeof input.enabled !== 'boolean') throw new Error('操作参数无效');
  if (!input.enabled) return disableDefaults(input, home);
  const authority = await managementAuthority(home);
  return withLock(pluginConfig(id, home), async () => {
    const profile = await currentProfile(input, home, deps);
    const config = await readJson(pluginConfig(id, home));
    const previous = structuredClone(config);
    let bot = await getBot(profile.appId, home);
    const existing = defaultBinding(config, profile.appId);
    const legacyProfile = config.profiles?.find(value => value.appId === profile.appId);
    if (input.action === 'forwarding' && profile.cliId !== 'codex') throw new Error('TraeX 不提供独立模型转发开关');
    if (input.enabled && !enabled(bot, await readJson(join(home, 'config.json')), await readJson(join(home, 'plugins-registry.json')))) {
      throw new Error('请先为此 Bot 启用插件范围；管理页会在开启线路前自动完成此步骤');
    }
    if (!existing && !input.enabled) {
      await assertManagementAuthority(home, authority);
      config.topicDefaults = { ...config.topicDefaults, schemaVersion: 1,
        scopes: { ...config.topicDefaults?.scopes, [profile.appId]: false } };
      await atomicJson(pluginConfig(id, home), config);
      return controlStatus(home, deps);
    }
    if ((!existing || input.enabled) && !profile.controlRuntimeOnline) throw new Error('请先等待环境准备完成并在本页完成字节内部登录');
    const selection = !existing || input.enabled ? configuredModelChoice(bot, profile.modelChoices)
      : selectedChoice(bot, profile.modelChoices) || existing.selection;
    if (['acceleration', 'master'].includes(input.action) && input.enabled) {
      if (input.action === 'acceleration' && profile.cliId === 'codex' && !profile.connection.enabled) throw new Error('请先开启模型转发，再开启同模型加速');
      if (!selection?.accelerationAvailable) throw new Error('当前模型没有已核验的加速能力');
    }
    if (input.enabled && !enabled(bot, await readJson(join(home, 'config.json')), await readJson(join(home, 'plugins-registry.json')))) {
      // Settings PUT already holds the host plugin lifecycle lock. Calling the
      // host scope PUT here would try to acquire that same lock over HTTP and
      // deadlock a fresh Bot. The UI explicitly enables scope first, refreshes
      // this revision, and only then calls this locked control action.
      throw new Error('请先为此 Bot 启用插件范围；管理页会在开启线路前自动完成此步骤');
    }
    if (input.enabled && input.action !== 'master' && !profile.pluginEnabled) {
      throw new Error('请先打开此 Bot 的新话题总开关');
    }
    const binding = existing ? structuredClone(existing)
      : await (deps.prepareClientBinding || prepareClientBinding)(bot, legacyProfile, home, deps);
    if (existing) {
      const expectedPath = binding.native?.legacy?.alias?.path || binding.launcher;
      if (bot.cliPathOverride !== expectedPath && bot.cliRuntime?.executable !== expectedPath) throw new Error('客户端启动入口已被修改，未覆盖');
    }
    if (digest(await readFile(binding.launcher, 'utf8')) !== binding.launcherHash) throw new Error('FERRY 启动器内容已变化');
    if (!existing) Object.assign(binding, { forwarding: profile.cliId === 'codex' && profile.connection.enabled,
      acceleration: profile.enabled === true, legacyProfileId: legacyProfile?.id });
    Object.assign(binding, { selection, modelChoices: profile.modelChoices });
    if (input.action === 'master') {
      binding.forwarding = profile.cliId === 'codex' && input.enabled;
      binding.acceleration = input.enabled;
    } else binding[input.action] = input.enabled;
    if (input.action === 'forwarding' && !input.enabled) binding.acceleration = false;
    const runtime = await (deps.managedRuntimeStatus || managedRuntimeStatus)(home, deps);
    if (runtime.online && profile.modelChoices.length) {
      binding.modelCatalog = await (deps.prepareClientCatalog || prepareClientCatalog)(bot, profile.modelChoices, home, runtime, deps);
    }
    const bridge = !existing ? await prepareLegacyBridge(binding, bot.larkAppId, home) : null;
    if (binding.native?.legacy) for (const [path, expected] of Object.entries(binding.native.legacy.hashes)) {
      if (bridge && path === bridge.metadata.path) continue;
      if (digest(await readFile(path, 'utf8')) !== expected) throw new Error('旧会话启动入口已变化，未覆盖');
    }
    config.controlPlane = { ...config.controlPlane, schemaVersion: 1, runtimeWanted: true,
      // Freeze pre-0.6 bindings and legacy flags. Old daemons still read them.
      bots: { ...config.controlPlane?.bots, ...(!config.controlPlane?.bots?.[profile.appId]
        ? { [profile.appId]: { ...binding, acceleration: profile.priorRouting.acceleration === true,
          forwarding: profile.cliId === 'codex' && profile.priorRouting.forwarding === true } } : {}) } };
    config.topicDefaults = { ...config.topicDefaults, schemaVersion: 1,
      revision: (config.topicDefaults?.revision || 0) + 1,
      scopes: { ...config.topicDefaults?.scopes, [profile.appId]: input.action === 'master' ? input.enabled : profile.pluginEnabled },
      bindings: { ...config.topicDefaults?.bindings, [profile.appId]: binding } };
    if (!deps.deferLiveControls) setLiveAcceleration(config, profile.appId,
      binding.acceleration === true && (input.action === 'master' ? input.enabled : profile.pluginEnabled));
    if (!deps.deferLiveControls && (bot.cliId === 'traex' || ['master', 'forwarding'].includes(input.action))) {
      setRoutingIntent(config, profile.appId, 'gateway', authority);
    }
    let transaction;
    try {
      await assertManagementAuthority(home, authority);
      await atomicJson(pluginConfig(id, home), config);
      await applyLegacyBridge(bridge);
      const patch = bindingPatch(bot, binding);
      if (Object.entries(patch).some(([field, value]) => JSON.stringify(bot[field]) !== JSON.stringify(value))) {
        transaction = await patchBot(home, bot.larkAppId, digest(bot), patch, authority);
        await (deps.reloadBot || reloadBot)(home, transaction.next, deps);
      }
      await assertManagementAuthority(home, authority);
      const saved = await getBot(bot.larkAppId, home);
      if (['model', 'modelBackendVariant', 'reasoningEffort', 'cliId'].some(field => saved[field] !== bot[field])) {
        throw new Error('Bot 模型或档位已被并发修改，未继续操作');
      }
    } catch (error) {
      await restoreLegacyBridge(bridge);
      if (transaction && !await rollbackBot(home, transaction)) throw new Error('配置已被并发修改，适配记录保留，请检查 Bot 设置');
      await atomicJson(pluginConfig(id, home), previous);
      if (transaction) await (deps.reloadBot || reloadBot)(home, transaction.previous, deps).catch(() => {});
      throw error;
    }
    return controlStatus(home, deps);
  });
}
