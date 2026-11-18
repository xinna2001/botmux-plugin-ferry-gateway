import { join } from 'node:path';
import { homePath, readJson, digest } from '../../../shared/state.mjs';
import { prepareDependencies, preparationStatus } from '../lib/onboarding.mjs';
import { managedRuntimeStatus } from '../lib/managed-runtime.mjs';
import { startJob, getJobStatus } from '../lib/setup.mjs';

const home = homePath();
const pluginId = 'gateway-acceleration';

async function installationAuthority() {
  const record = (await readJson(join(home, 'plugins-registry.json'))).plugins?.[pluginId];
  const expected = process.env.BOTMUX_PLUGIN_INSTALL_RECORD;
  if (!expected || !record || record.version !== __FERRY_PLUGIN_VERSION__
    || record.manifest?.prerequisites !== true || digest(record) !== expected) {
    throw new Error('安装授权已失效');
  }
  return expected;
}

if (process.argv[2] === 'installed') {
  await installationAuthority();
  // The install callback only prepares dependencies; SSO is always a user action.
  // A service may already be preparing the same plugin, so share its task lock.
  if ((await getJobStatus(home))?.state !== 'running') {
    try {
      await startJob('installed', async job => {
        await prepareDependencies(home, { installAuthority: installationAuthority }, job);
        job.progress = 'FERRY 已安装，请完成本人字节内部登录';
      }, home);
    } catch (error) {
      if (!/另一个操作/.test(error.message)) throw error;
    }
  }
} else if (process.argv[2] === 'check') {
  const runtime = await managedRuntimeStatus(home);
  const setup = await preparationStatus(home, {}, runtime);
  const ready = setup.ready === true && setup.authenticated === true
    && setup.compatible === true && setup.runtime?.ready === true && runtime.dependencies?.ready === true;
  const message = setup.job?.state === 'running' ? '前置准备正在进行，请等待完成'
    : !setup.installed || !setup.compatible ? '请先完成 FERRY 安装'
      : setup.authenticated !== true ? setup.statusError || '请先完成字节内部登录'
        : '网关尚未通过认证、依赖和模型目录检查，请在管理页重新检查';
  console.log(JSON.stringify({ ready: ready && setup.job?.state !== 'running', message }));
} else {
  throw new Error('不支持的准备操作');
}
