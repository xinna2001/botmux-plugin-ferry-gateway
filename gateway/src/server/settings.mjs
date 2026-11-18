import { adoptScope } from '../lib/gateway.mjs';
import { prepareInstall, installFerry, connectFerry, startJob } from '../lib/setup.mjs';
import { controlSettings, controlState, setControl, setDefaultScope } from '../lib/control-plane.mjs';
import { installRuntime } from '../lib/runtime.mjs';
import { bootstrapGateway, startManagedGateway, loginManagedGateway } from '../lib/onboarding.mjs';
import { checkAndUpdate } from '../lib/update.mjs';
import { invalidatePreparation } from '../lib/preparation-cache.mjs';
import { startVersionCheck } from '../lib/version-check.mjs';
import { applyManagedPort, forwardingConfiguration } from '../lib/connection-settings.mjs';

export async function getSettings() {
  return controlSettings();
}
export async function saveSettings(_api, value) {
  try {
    if (value?.action === 'read-state') return { ok: true, state: await controlState() };
    if (value?.action === 'default-scope') {
      const result = await setDefaultScope(value);
      return result.scopeOnly ? { ok: true, state: result } : { ok: true, snapshot: result };
    }
    if (value?.action === 'check-update') {
      return { ok: true, versionCheck: await startVersionCheck() };
    }
    if (value?.action === 'update-latest') {
      if (value.confirm !== true) throw new Error('需要明确确认');
      if (!/^\d+\.\d+\.\d+$/.test(value.version || '')) throw new Error('请先检查 FERRY 最新版本');
      return { ok: true, job: await startJob('update-latest', job => checkAndUpdate(undefined, {}, job, value.version)) };
    }
    if (value?.action === 'refresh') {
      await invalidatePreparation();
      return { ok: true, snapshot: await getSettings() };
    }
    if (value?.action === 'bootstrap') {
      if (value.confirm !== true) throw new Error('需要明确确认');
      return { ok: true, job: await startJob('bootstrap', job => bootstrapGateway(undefined, {}, job)) };
    }
    if (value?.action === 'scope') { await adoptScope(value.scope); return { ok: true, snapshot: await getSettings() }; }
    if (value?.action === 'model') throw new Error('请只在 Bot 设置中选择模型，网关不再提供第二套模型设置');
    if (['acceleration', 'forwarding', 'master'].includes(value?.action)) {
      const result = await setControl(value);
      return result.scopeOnly ? { ok: true, state: result } : { ok: true, snapshot: await getSettings() };
    }
    if (['start', 'initialize'].includes(value?.action)) {
      if (value.confirm !== true) throw new Error('需要明确确认');
      return { ok: true, job: await startJob('start', job => startManagedGateway(undefined, {}, job)) };
    }
    if (value?.action === 'runtime-install') {
      if (value.confirm !== true) throw new Error('需要明确确认');
      return { ok: true, job: await startJob('runtime-install', () => installRuntime(value)) };
    }
    if (value?.action === 'prepare-install') return { ok: true, plan: await prepareInstall() };
    if (value?.action === 'install') {
      if (value.confirm !== true) throw new Error('需要明确确认');
      return { ok: true, job: await startJob('install', () => installFerry(value)) };
    }
    if (value?.action === 'login') {
      if (value.confirm !== true) throw new Error('需要明确确认');
      return { ok: true, job: await startJob('login', job => loginManagedGateway(undefined, {}, job)) };
    }
    if (value?.action === 'connection-config') {
      return { ok: true, config: forwardingConfiguration(await getSettings(), value.appId) };
    }
    if (['connect', 'disconnect'].includes(value?.action)) {
      throw new Error('请使用本页的启动网关操作和逐 Bot 开关，不再管理另一份网关配置');
    }
    if (value?.action === 'port') {
      if (value.confirm !== true) throw new Error('需要明确确认将新话题网关切换端口；旧话题不改线路');
      if (!Number.isInteger(value.port) || value.port < 1024 || value.port > 65535) throw new Error('端口必须在 1024–65535 之间');
      return { ok: true, job: await startJob('change-port', job => {
        job.progress = '正在核验并启动指定端口的新网关，旧话题保持原线路';
        return applyManagedPort(value).then(result => { job.progress = `已核验新话题网关端口 ${result.port}`; });
      }) };
    }
    throw new Error('不支持的操作');
  } catch (error) {
    return { ok: false, error: /^(请|需要|已经|已存在|配置|当前|与|端口|尚未|固定|客户端|另一个|已有|此网关|FERRY|网关|安装确认|无法核验)/.test(error.message)
      ? error.message : '操作未完成，请检查网关和依赖状态后重试' };
  }
}
