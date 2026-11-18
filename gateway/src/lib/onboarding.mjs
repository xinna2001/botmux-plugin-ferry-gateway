import { homePath, atomicJson, readJson, pluginConfig, withLock } from '../../../shared/state.mjs';
import { detectFerry, setupStatus, prepareInstall, installFerry, getJobStatus, startJob, connectFerry } from './setup.mjs';
import { runtimeStatus, installRuntime } from './runtime.mjs';
import { ensureManagedRuntime, prepareManagedDependencies } from './managed-runtime.mjs';
import { managementAuthority, assertManagementAuthority } from './host-control.mjs';
import { supportedRuntime } from './runtime-instrument.mjs';
import { invalidatePreparation } from './preparation-cache.mjs';

export async function preparationStatus(home = homePath(), deps = {}, runtime = {}) {
  const [node, detected, dependency] = await Promise.all([
    (deps.runtimeStatus || runtimeStatus)(home, deps),
    (deps.detectFerry || detectFerry)(home, deps),
    (deps.setupStatus || setupStatus)(home, { ...deps, compatibleOnly: true,
      ...(runtime.upstreamVersion ? { targetVersion: runtime.upstreamVersion } : {}) }),
  ]);
  const phase = !node.ready ? 'runtime' : !dependency.installed || !dependency.adapterCompatible
    ? 'dependency' : runtime.online && runtime.dependencies?.ready === false ? 'dependency-error'
      : runtime.online ? runtime.authenticated !== true
        ? dependency.authenticated === true ? 'gateway-auth' : 'login'
        : runtime.catalogReady !== true ? 'catalog' : runtime.ready === true ? 'ready' : 'gateway-auth'
      : dependency.statusError ? 'auth-error' : dependency.authenticated !== true ? 'login' : 'gateway';
  return { ...dependency, phase, runtime: node, compatible: dependency.adapterCompatible === true,
    detectedVersion: detected?.version, detectedSource: detected?.source,
    requiredVersion: supportedRuntime.version, job: dependency.job || await getJobStatus(home),
    serving: runtime, ready: phase === 'ready' };
}

export async function prepareDependencies(home = homePath(), deps = {}, job = {}) {
  const authority = await (deps.installAuthority ? deps.installAuthority() : managementAuthority(home));
  const check = async () => {
    if (deps.installAuthority) {
      if (await deps.installAuthority() !== authority) throw new Error('安装授权已失效');
    } else await assertManagementAuthority(home, authority);
  };
  job.progress = '正在检查运行环境';
  if (!(await (deps.runtimeStatus || runtimeStatus)(home, deps)).ready) {
    job.progress = '正在安装独立 Node.js 运行环境';
    await check();
    await (deps.installRuntime || installRuntime)({ confirm: true }, home, deps);
  }
  if (!await (deps.detectFerry || detectFerry)(home, { ...deps, targetVersion: deps.targetVersion || supportedRuntime.version, compatibleOnly: true })) {
    job.progress = `正在安装独立 FERRY ${supportedRuntime.version}，不替换现有全局安装`;
    const plan = await (deps.prepareInstall || prepareInstall)(home, deps);
    await check();
    await (deps.installFerry || installFerry)({ nonce: plan.nonce, confirm: true }, home, deps);
  }
  let dependency = await (deps.setupStatus || setupStatus)(home, { ...deps, compatibleOnly: true });
  if (!dependency.installed || !dependency.adapterCompatible) throw new Error('安装结果尚未通过 FERRY 身份核验');
  job.progress = '正在核验守护进程的 ByteCloud 登录依赖';
  await check();
  await (deps.prepareManagedDependencies || prepareManagedDependencies)(home, deps);
  await check();
  await invalidatePreparation(home);
  return { prepared: true };
}

export async function preparePrerequisites(home = homePath(), deps = {}, job = {}) {
  await prepareDependencies(home, deps, job);
  let dependency;
  dependency = await (deps.setupStatus || setupStatus)(home, { ...deps, compatibleOnly: true });
  if (dependency.statusError) throw new Error('FERRY 登录状态查询失败，请检查依赖后重试；未判定为未登录');
  if (dependency.authenticated !== true) {
    job.progress = '依赖已准备好，请在此页完成本人字节内部登录';
    return { requiresLogin: true };
  }
  job.progress = '依赖与本人登录已就绪，正在准备启动网关';
  return { prepared: true, requiresStart: true };
}

export async function startManagedGateway(home = homePath(), deps = {}, job = {}) {
  const authority = await managementAuthority(home);
  const prepared = await preparePrerequisites(home, deps, job);
  if (prepared.requiresLogin) throw new Error('请先完成本人字节内部登录，再启动网关');
  return activatePreparedGateway(home, deps, job, authority);
}

async function activatePreparedGateway(home, deps, job, authority) {
  job.progress = '正在启动并核验实际网关认证与模型目录';
  await assertManagementAuthority(home, authority);
  const file = pluginConfig('gateway-acceleration', home);
  await withLock(file, async () => {
    const config = await readJson(file);
    await assertManagementAuthority(home, authority);
    config.controlPlane = { ...config.controlPlane, schemaVersion: 1, runtimeWanted: true,
      bots: config.controlPlane?.bots || {} };
    await atomicJson(file, config);
  });
  const runtime = await (deps.ensureManagedRuntime || ensureManagedRuntime)(home, deps);
  job.progress = runtime.ready ? '实际网关已就绪，可以操作开关'
    : '网关已启动，正在等待实际认证与模型目录；尚未标记为就绪';
  return { ready: runtime.ready === true, runtime };
}

export async function bootstrapGateway(home = homePath(), deps = {}, job = {}) {
  const authority = await managementAuthority(home);
  const prepared = await preparePrerequisites(home, deps, job);
  if (prepared.requiresLogin) return prepared;
  return activatePreparedGateway(home, deps, job, authority);
}

export async function loginManagedGateway(home = homePath(), deps = {}, job = {}) {
  const authority = await managementAuthority(home);
  await preparePrerequisites(home, deps, job);
  await assertManagementAuthority(home, authority);
  job.progress = '请在新打开的页面完成本人字节内部登录，完成后将自动启动网关';
  await (deps.connectFerry || connectFerry)({ action: 'login', confirm: true }, home, {
    ...deps, compatibleOnly: true, onLoginUrl: url => { job.loginUrl = url; },
  });
  delete job.loginUrl;
  await invalidatePreparation(home);
  await assertManagementAuthority(home, authority);
  return startManagedGateway(home, deps, job);
}

export async function automaticPreparation(home = homePath(), deps = {}, runtime = {}) {
  // Wait for the host's management identity. Never perform SSO in background,
  // and never repeatedly retry a failed operation on a ten-second service poll.
  try { await managementAuthority(home); } catch { return; }
  const previous = await getJobStatus(home);
  if ((previous && !(previous.operation === 'installed' && previous.state === 'complete'))
    || runtime.ready === true) return;
  try {
    return await startJob('bootstrap', job => bootstrapGateway(home, deps, job), home);
  } catch (error) {
    if (!/另一个操作/.test(error.message)) throw error;
  }
}
