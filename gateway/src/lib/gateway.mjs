import { readFile, readdir } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { parse } from 'smol-toml';
import { homePath, readJson, atomicJson, withLock, digest, pluginConfig, getBot, enabledFor } from '../../../shared/state.mjs';
import { managedClient, clientModelMatches } from './client-launcher.mjs';
export { homePath, readJson, atomicJson, withLock };
export const PLUGIN_ID = 'gateway-acceleration';
const idPattern = /^[a-z][a-z0-9-]{0,63}$/;
const supportedModel = /^(?:ferry|claude)-gpt-(?:5-6|6|6-1)-[a-z0-9-]+(?:\[1m\])?$/;
const supportedClients = new Set(['codex', 'claude-code', 'traex']);

export async function loadProfiles(home = homePath()) {
  const config = await readJson(pluginConfig(PLUGIN_ID, home));
  const profiles = config.profiles ?? [];
  if (!Array.isArray(profiles) || profiles.length > 100) throw new Error('网关配置格式无效');
  const seen = new Set();
  return profiles.map(value => {
    if (!idPattern.test(value.id) || seen.has(value.id) || typeof value.appId !== 'string'
      || !Number.isInteger(value.port) || value.port < 1024 || value.port > 65535
      || typeof value.model !== 'string' || value.model.length > 120) throw new Error('网关配置格式无效');
    seen.add(value.id);
    return { ...value, name: String(value.name || value.id), modelLabel: String(value.modelLabel || value.model) };
  });
}
export async function health(profile, home = homePath(), fetcher = fetch) {
  const runtime = await readJson(join(home, 'local', profile.id, 'data/runtime.json'), null);
  if (!runtime || runtime.port !== profile.port || !Number.isInteger(runtime.pid) || typeof runtime.token !== 'string') {
    return { online: false, reason: '服务未就绪' };
  }
  try {
    const response = await fetcher(`http://127.0.0.1:${profile.port}/_ferry/health`, {
      headers: { 'x-ferry-token': runtime.token }, redirect: 'error', signal: AbortSignal.timeout(1500),
    });
    const value = await response.json();
    if (!response.ok || value.ok !== true || value.pid !== runtime.pid || value.port !== profile.port) return { online: false, reason: '服务身份不匹配' };
    return { online: true, version: String(value.version), activeRequests: Number.isInteger(value.active_requests) ? value.active_requests : null };
  } catch { return { online: false, reason: '网关暂不可达' }; }
}
export async function routeEvidence(bot, profile) {
  const route = profile.route;
  if (!route) return { verified: false, reason: '尚未核验客户端线路' };
  if (route.mode === 'pinned-launcher') {
    if (!isAbsolute(route.path || '') || bot.cliPathOverride !== route.path || !/^[a-f0-9]{64}$/.test(route.sha256 || '')) return { verified: false, reason: '客户端启动入口已变化' };
    try {
      const hash = digest(await readFile(route.path, 'utf8'));
      return { verified: hash === route.sha256 && route.port === profile.port && route.model === profile.model && route.cliId === bot.cliId,
        reason: '已核验的启动入口与当前配置不一致' };
    } catch { return { verified: false, reason: '客户端启动入口不可读' }; }
  }
  if (route.mode === 'codex-config' && bot.cliId === 'codex' && !bot.cliPathOverride && isAbsolute(route.path || '')) {
    try {
      const value = parse(await readFile(route.path, 'utf8'));
      const provider = value.model_provider;
      const url = value.model_providers?.[provider]?.base_url;
      const expected = `http://127.0.0.1:${profile.port}/v1`;
      return { verified: url === expected && value.model === bot.model && typeof provider === 'string', reason: '当前 Codex 配置未指向此 FERRY 网关' };
    } catch { return { verified: false, reason: 'Codex 配置无法核验' }; }
  }
  return { verified: false, reason: '当前启动方式尚未接入线路核验' };
}
export function forwardingStatus(bot, profile, route, online) {
  const state = (code, reason) => ({ ready: code === 'ready', code, reason });
  if (!supportedClients.has(bot.cliId) || (bot.cliId === 'traex' && !managedClient(profile))) return state('cli', '此客户端尚未适配；不会自动切换到 FERRY');
  if (!route.verified || !clientModelMatches(bot, profile) || bot.model === 'auto') {
    return state('route', '尚未核验此 Bot 的 FERRY 转发线路');
  }
  if (!online) return state('offline', 'FERRY 网关离线');
  return state('ready', 'FERRY 转发线路已接入');
}
export function hasIndependentAcceleration(profile) {
  // Legacy launchers can use this same flag to change provider/model.
  return profile.acceleration?.kind === 'existing-flag-v1'
    && profile.acceleration.control === 'acceleration-only';
}
export function compatibility(bot, profile, route, pluginEnabled, online) {
  if (!pluginEnabled) return { eligible: false, code: 'scope', reason: '插件尚未为此 Bot 启用' };
  if (bot.model === 'auto' || bot.traexAutoModel?.enabled === true) return { eligible: false, code: 'auto', reason: '与实验性自动选模型互斥，请先关闭自动选模型' };
  if (!supportedClients.has(bot.cliId) || (bot.cliId === 'traex' && !managedClient(profile))) return { eligible: false, code: 'cli', reason: '当前客户端不支持此加速控制' };
  if (!clientModelMatches(bot, profile) || !supportedModel.test(profile.model)) return { eligible: false, code: 'model', reason: '需要选择网关明确支持的固定 GPT 模型和档位' };
  if (!route.verified) return { eligible: false, code: 'route', reason: route.reason };
  if (!online) return { eligible: false, code: 'offline', reason: 'FERRY 网关离线' };
  if (!profile.acceleration?.models?.includes(profile.model)) {
    return { eligible: false, code: 'adapter', reason: '此网关尚未提供插件加速接口；可使用 FERRY 原生加速' };
  }
  if (!hasIndependentAcceleration(profile)) return { eligible: false, code: 'coupled', reason: '尚未核验独立加速控制；保留现有线路不变' };
  return { eligible: true, code: 'ready', reason: '固定模型与线路已核验；加速仍可能排队' };
}
async function enabledSetting(profile, home) {
  const root = join(home, 'local', profile.id);
  const flag = await readJson(join(root, 'acceleration.json'), null);
  return flag ? flag.enabled === true : (await readJson(join(root, 'policy.json'))).enabled === true;
}
export async function recentRequests(profile, home = homePath()) {
  const root = join(home, 'local', profile.id, 'states');
  let names;
  try { names = await readdir(root); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const rows = await Promise.all(names.filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).slice(-200).map(async name => {
    const item = await readJson(join(root, name), null).catch(() => null);
    if (!item || item.botAppId !== profile.appId || item.model !== profile.model) return null;
    return { session: String(item.sessionId).slice(0, 8), phase: ['waiting', 'queued', 'answering', 'complete', 'error'].includes(item.phase) ? item.phase : 'unknown',
      position: Number.isInteger(item.position) ? item.position : null, accelerated: item.moved === true,
      observedAt: Number(item.observedAt) || 0, stale: Date.now() - Number(item.observedAt) > 120000 };
  }));
  return rows.filter(Boolean).sort((a, b) => b.observedAt - a.observedAt).slice(0, 5);
}
export async function status(home = homePath(), fetcher = fetch) {
  const config = await readJson(pluginConfig(PLUGIN_ID, home));
  const profiles = await Promise.all((await loadProfiles(home)).map(async profile => {
    let bot;
    try { bot = await getBot(profile.appId, home); } catch { bot = {}; }
    const [currentHealth, route, enabled, pluginEnabled, requests] = await Promise.all([
      health(profile, home, fetcher), routeEvidence(bot, profile), enabledSetting(profile, home),
      bot.larkAppId ? enabledFor(PLUGIN_ID, profile.appId, home) : false, recentRequests(profile, home),
    ]);
    const forwardingControl = ['codex', 'claude-code'].includes(bot.cliId)
      && managedClient(profile) && profile.forwarding?.kind === 'separate-flag-v1';
    const forwarding = forwardingControl ? (await readJson(join(home, 'local', profile.id, 'forwarding.json'), { enabled: false })).enabled === true : route.verified;
    const activeRoute = forwardingControl && !forwarding ? { verified: false, reason: '请先开启模型转发' } : route;
    const match = compatibility(bot, profile, activeRoute, pluginEnabled, currentHealth.online);
    const controlAvailable = supportedClients.has(bot.cliId) && hasIndependentAcceleration(profile)
      && (bot.cliId !== 'traex' || managedClient(profile));
    return {
      id: profile.id, appId: profile.appId, name: bot.name || profile.name, model: bot.model || '', modelLabel: bot.model || '未选择模型',
      cliId: bot.cliId || '', configured: !!bot.larkAppId, pluginEnabled, enabled,
      autoModel: bot.model === 'auto' || bot.traexAutoModel?.enabled === true,
      connection: { verified: route.verified, online: currentHealth.online, enabled: forwarding, controlAvailable: forwardingControl,
        ...forwardingStatus(bot, profile, activeRoute, currentHealth.online) },
      compatibility: match, controlAvailable,
      health: currentHealth, requests, adopted: Object.hasOwn(config.managedProfiles || {}, profile.id),
      configHash: digest(config), botHash: digest(bot),
      revision: digest({ config, bot, route, enabled, forwarding, pluginEnabled }),
    };
  }));
  return { schemaVersion: 2, observedAt: Date.now(), profiles };
}
export async function setForwarding({ profileId, enabled, revision }, home = homePath(), deps = {}) {
  if (typeof enabled !== 'boolean' || typeof revision !== 'string') throw new Error('操作参数无效');
  return withLock(pluginConfig(PLUGIN_ID, home), async () => {
    const row = (await status(home, deps.fetcher || fetch)).profiles.find(row => row.id === profileId);
    if (!row || row.revision !== revision) throw new Error('配置已变化，请刷新重试');
    if (!row.connection.controlAvailable || !row.connection.verified) throw new Error('尚未核验独立转发控制');
    if (enabled && (!row.pluginEnabled || !row.health.online)) throw new Error('请先启用插件并连接 FERRY');
    const config = await readJson(pluginConfig(PLUGIN_ID, home));
    const bot = await getBot(row.appId, home);
    if (digest(config) !== row.configHash || digest(bot) !== row.botHash) throw new Error('配置已变化，请刷新重试');
    const profile = config.profiles.find(profile => profile.id === profileId);
    if (!enabled && profile.client.model.startsWith('ferry-')) throw new Error('当前模型仅由 FERRY 提供，请先选择原生模型');
    if (!clientModelMatches(bot, profile)) throw new Error('当前模型或档位尚未适配');
    await atomicJson(join(home, 'local', profileId, 'forwarding.json'), { enabled });
    return status(home, deps.fetcher || fetch);
  });
}
export async function setAcceleration({ profileId, enabled, revision }, home = homePath(), deps = {}) {
  if (typeof enabled !== 'boolean' || typeof revision !== 'string') throw new Error('操作参数无效');
  return withLock(pluginConfig(PLUGIN_ID, home), async () => {
    const current = (await status(home, deps.fetcher || fetch)).profiles.find(item => item.id === profileId);
    if (!current) throw new Error('未知网关');
    if (current.revision !== revision) throw new Error('配置已变化，请刷新重试');
    if (!current.controlAvailable) throw new Error('尚未核验独立加速控制，不能改动现有线路');
    if (enabled && !current.compatibility.eligible) throw new Error(current.compatibility.reason);
    const config = await readJson(pluginConfig(PLUGIN_ID, home));
    const latestBot = await getBot(current.appId, home).catch(() => ({}));
    if (digest(config) !== current.configHash || digest(latestBot) !== current.botHash) throw new Error('配置已变化，请刷新重试');
    config.managedProfiles = { ...config.managedProfiles, [profileId]: { requested: enabled } };
    await atomicJson(pluginConfig(PLUGIN_ID, home), config);
    await atomicJson(join(home, 'local', profileId, 'acceleration.json'), { enabled });
    return status(home, deps.fetcher || fetch);
  });
}
export async function reconcileScopes(home = homePath()) {
  await withLock(pluginConfig(PLUGIN_ID, home), async () => {
    const config = await readJson(pluginConfig(PLUGIN_ID, home));
    for (const row of (await status(home)).profiles) {
      if (!Object.hasOwn(config.managedProfiles || {}, row.id)) continue;
      if (!row.controlAvailable) continue;
      const desired = config.managedProfiles[row.id].requested === true && row.compatibility.eligible;
      if (row.enabled !== desired) await atomicJson(join(home, 'local', row.id, 'acceleration.json'), { enabled: desired });
    }
  });
}
export async function adoptScope() {
  // Scope changes never opt a gateway into acceleration.
  return status();
}
