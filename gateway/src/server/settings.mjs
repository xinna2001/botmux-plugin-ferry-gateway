import { adoptScope } from '../lib/gateway.mjs';
import { prepareInstall, installFerry, connectFerry, startJob, connectionConfig } from '../lib/setup.mjs';
import { readJson, atomicJson, withLock, pluginConfig, digest } from '../../../shared/state.mjs';
import { controlSettings, selectControlModel, setControl, initializeControlRuntime } from '../lib/control-plane.mjs';
import { installRuntime } from '../lib/runtime.mjs';

export async function getSettings() {
  return controlSettings();
}
export async function saveSettings(_api, value) {
  try {
    if (value?.action === 'scope') { await adoptScope(value.scope); return { ok: true, snapshot: await getSettings() }; }
    if (value?.action === 'model') { await selectControlModel(value); return { ok: true, snapshot: await getSettings() }; }
    if (['acceleration', 'forwarding'].includes(value?.action)) { await setControl(value); return { ok: true, snapshot: await getSettings() }; }
    if (value?.action === 'initialize') {
      if (value.confirm !== true) throw new Error('需要明确确认');
      return { ok: true, job: startJob('initialize', () => initializeControlRuntime()), snapshot: await getSettings() };
    }
    if (value?.action === 'runtime-install') {
      if (value.confirm !== true) throw new Error('需要明确确认');
      return { ok: true, job: startJob('runtime-install', () => installRuntime(value)), snapshot: await getSettings() };
    }
    if (value?.action === 'prepare-install') return { ok: true, plan: await prepareInstall() };
    if (value?.action === 'install') {
      if (value.confirm !== true) throw new Error('需要明确确认');
      return { ok: true, job: startJob('install', () => installFerry(value)), snapshot: await getSettings() };
    }
    if (['login', 'connect', 'disconnect'].includes(value?.action)) {
      if (value.confirm !== true) throw new Error('需要明确确认');
      return { ok: true, job: startJob(value.action, job => connectFerry(value, undefined,
        { onLoginUrl: url => { job.loginUrl = url; } })), snapshot: await getSettings() };
    }
    if (value?.action === 'connection-config') return { ok: true, config: await connectionConfig() };
    if (value?.action === 'port') {
      if (!Number.isInteger(value.port) || value.port < 1024 || value.port > 65535) throw new Error('端口必须在 1024–65535 之间');
      const file = pluginConfig('gateway-acceleration');
      await withLock(file, async () => {
        const config = await readJson(file);
        if (value.revision !== digest(config)) throw new Error('配置已变化，请刷新重试');
        config.ferry = { ...config.ferry, port: value.port };
        await atomicJson(file, config);
      });
      return { ok: true, snapshot: await getSettings() };
    }
    throw new Error('不支持的操作');
  } catch (error) {
    return { ok: false, error: /^(请|需要|已经|已存在|配置|当前|与|端口|尚未|固定|客户端|另一个|已有|此网关|FERRY|网关|安装确认|无法核验)/.test(error.message)
      ? error.message : '操作未完成，请检查网关和依赖状态后重试' };
  }
}
