import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, open, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { atomicJson, digest, readJson, withLock } from '../../../shared/state.mjs';
import { detectFerry, setupStatus } from './setup.mjs';
import { detectRuntime } from './runtime.mjs';
import { instrumentRuntime, supportedRuntime, runtimeVersion, sourceRuntime, INSTRUMENTATION_REVISION } from './runtime-instrument.mjs';
import { ensureRuntimeDependencies, runtimeDependencyStatus } from './runtime-dependencies.mjs';

const rootPath = home => join(home, 'plugins/gateway-acceleration/private/runtime');
const recordPath = home => join(rootPath(home), 'prepared.json');
const recoveries = new Map();
const dependencyChecks = new Map();
const generationKey = (target, policyHash) => digest({
  sourceHash: target.sha256, policyHash, adapterRevision: INSTRUMENTATION_REVISION,
}).slice(0, 16);
let policyBytes;
async function policySource(deps = {}) {
  if (deps.policyFile) return readFile(deps.policyFile);
  policyBytes ||= readFile(fileURLToPath(new URL('../runtime/policy.mjs', import.meta.url)))
    .catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return readFile(fileURLToPath(new URL('./runtime-policy.mjs', import.meta.url)));
    });
  return policyBytes;
}

export function servingHealth(status, now = Date.now()) {
  const authenticated = ['bytecloud', 'traecli', 'env'].includes(status?.auth?.source)
    && Number.isFinite(Date.parse(status.auth.expiresAt)) && Date.parse(status.auth.expiresAt) > now;
  const models = status?.catalog?.models;
  const catalogReady = Number.isInteger(models) && models > 0;
  return { authenticated, catalogReady, modelCount: Number.isInteger(models) ? models : 0,
    authSource: authenticated ? status.auth.source : undefined,
    authExpiresAt: authenticated ? status.auth.expiresAt : undefined,
    ready: authenticated && catalogReady };
}

export async function recoverManagedRuntime(home, deps = {}) {
  if (recoveries.has(home)) return recoveries.get(home);
  const pending = (async () => {
    const config = await readJson(join(home, 'plugins/gateway-acceleration/config.json'));
    if (config.controlPlane?.runtimeWanted !== true) return;
    const current = await managedRuntimeStatus(home, deps);
    const prepared = await readJson(recordPath(home), null);
    if (current.ready && prepared?.version === (deps.targetVersion || supportedRuntime.version)
      && prepared?.policyHash === digest((await policySource(deps)).toString('utf8'))
      && prepared?.adapterRevision === INSTRUMENTATION_REVISION) {
      return current; // No repeated Node/FERRY discovery on healthy service polls.
    }
    return (deps.ensureManagedRuntime || ensureManagedRuntime)(home, deps);
  })();
  recoveries.set(home, pending);
  try { return await pending; }
  finally { if (recoveries.get(home) === pending) recoveries.delete(home); }
}

export async function ferryAdmin(runtime, path, fetcher = fetch) {
  if (!Number.isInteger(runtime?.port) || runtime.port < 1024 || runtime.port > 65535
    || !Number.isInteger(runtime.pid) || typeof runtime.token !== 'string') throw new Error('FERRY 运行状态无效');
  if (!['status', 'models'].includes(path)) throw new Error('无效的 FERRY 只读请求');
  const response = await fetcher(`http://127.0.0.1:${runtime.port}/_ferry/${path}`, {
    headers: { 'x-ferry-token': runtime.token }, redirect: 'error', signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('FERRY 接口暂不可用');
  const value = await response.json();
  if (path === 'status' && (value.pid !== runtime.pid || value.port !== runtime.port)) {
    throw new Error('FERRY 进程身份不一致');
  }
  return value;
}

export async function managedRuntimeStatus(home, deps = {}) {
  const prepared = deps.prepared || await readJson(recordPath(home), null);
  if (!prepared || !sourceRuntime(prepared.sourceHash, prepared.version)) return { online: false };
  const runtime = await readJson(join(prepared.dataHome, 'runtime.json'), null);
  if (!runtime || runtime.port !== prepared.port) return { online: false };
  try {
    const status = await ferryAdmin(runtime, 'status', deps.fetcher);
    const dependencies = await (deps.runtimeDependencyStatus || runtimeDependencyStatus)(home, {
      packageRoot: prepared.packageRoot, entry: join(prepared.packageRoot || '', 'dist/cli.js'),
    }, { directory: prepared.sdkDirectory });
    const health = servingHealth(status);
    return { online: true, port: runtime.port, pid: runtime.pid,
      version: String(status.version), activeRequests: status.active_requests,
      upstreamVersion: prepared.version,
      adapterRevision: prepared.adapterRevision, controlProtocol: prepared.controlProtocol || 0,
      ...health, dependencies, ready: health.ready && dependencies.ready };
  } catch { return { online: false }; }
}

async function checkedDependencies(home, installed, runtime, deps) {
  const status = await (deps.runtimeDependencyStatus || runtimeDependencyStatus)(home, installed, deps);
  const key = `${installed.packageRoot}:${runtime.node}:${deps.directory || ''}`;
  if (status.ready && dependencyChecks.get(home) === key) return status;
  const result = await (deps.ensureRuntimeDependencies || ensureRuntimeDependencies)(home, installed, runtime, deps);
  dependencyChecks.set(home, key);
  return result;
}

export async function prepareManagedDependencies(home, deps = {}) {
  await mkdir(rootPath(home), { recursive: true, mode: 0o700 });
  return withLock(join(rootPath(home), 'operation'), async () => {
    const target = runtimeVersion(deps.targetVersion || supportedRuntime.version);
    const installed = await (deps.detectFerry || detectFerry)(home, { ...deps, targetVersion: target.version, compatibleOnly: true });
    if (!installed || installed.version !== target.version) throw new Error('FERRY 兼容依赖尚未安装');
    const runtime = await (deps.detectRuntime || detectRuntime)(home);
    if (!runtime) throw new Error('请先补足 Node.js 运行环境');
    const prepared = await readJson(recordPath(home), null);
    const hash = digest((await policySource(deps)).toString('utf8'));
    const directory = prepared?.version === target.version && prepared?.policyHash === hash
      && prepared?.adapterRevision === INSTRUMENTATION_REVISION ? prepared.sdkDirectory
      : join(rootPath(home), 'generations', `${target.version}-${generationKey(target, hash)}`);
    return checkedDependencies(home, installed, runtime, { ...deps, directory });
  });
}

async function assertFreePort(port) {
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', () => reject(new Error('FERRY 端口已被占用，未停止或替换已有服务')));
    server.listen(port, '127.0.0.1', () => server.close(error => error ? reject(error) : resolve()));
  });
}

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

export async function ensureManagedRuntime(home, deps = {}) {
  if (deps.requestedPort !== undefined && (!Number.isInteger(deps.requestedPort)
    || deps.requestedPort < 1024 || deps.requestedPort > 65535)) throw new Error('端口必须在 1024–65535 之间');
  await mkdir(rootPath(home), { recursive: true, mode: 0o700 });
  return withLock(join(rootPath(home), 'operation'), async () => {
    const target = runtimeVersion(deps.targetVersion || supportedRuntime.version);
    const installed = await (deps.detectFerry || detectFerry)(home, { ...deps, targetVersion: target.version, compatibleOnly: true });
    if (!installed || installed.version !== target.version) {
      throw new Error(`需要已核验的 FERRY ${target.version} 运行时；不会覆盖或降级已有全局安装`);
    }
    const runtime = await (deps.detectRuntime || detectRuntime)(home);
    if (!runtime) throw new Error('请先补足 Node.js 运行环境');
    const policy = await policySource(deps);
    const policyHash = digest(policy.toString('utf8'));
    const preparedBefore = await readJson(recordPath(home), null);
    const sameGeneration = preparedBefore?.policyHash === policyHash
      && preparedBefore.sourceHash === target.sha256 && preparedBefore.version === target.version
      && preparedBefore.adapterRevision === INSTRUMENTATION_REVISION
      && (deps.requestedPort === undefined || deps.requestedPort === preparedBefore.port);
    const generation = sameGeneration ? dirname(preparedBefore.program)
      : join(rootPath(home), 'generations',
        `${target.version}-${generationKey(target, policyHash)}${deps.requestedPort === undefined ? '' : `-p${deps.requestedPort}`}`);
    const sdkDirectory = sameGeneration ? preparedBefore.sdkDirectory
      : preparedBefore?.policyHash ? generation : undefined;
    // Each new generation has its own SDK links. Do not change the ESM lookup
    // tree of an old daemon which may still perform later tool-result calls.
    await checkedDependencies(home, installed, runtime, { ...deps, directory: sdkDirectory });
    const current = await managedRuntimeStatus(home, deps);
    if (current.online && sameGeneration) { await deps.beforePublish?.(); return current; }
    // New plugin policy gets its own daemon generation. Never replace the
    // loaded policy or data directory that existing topics still depend on.
    if (preparedBefore && !await readJson(join(rootPath(home), 'pre-060.json'), null)) {
      await atomicJson(join(rootPath(home), 'pre-060.json'), preparedBefore);
    }
    const authenticated = await (deps.setupStatus || setupStatus)(home, { ...deps, compatibleOnly: true });
    if (authenticated.authenticated !== true) throw new Error('请先完成本人内部登录');
    const config = await readJson(join(home, 'plugins/gateway-acceleration/config.json'));
    const port = sameGeneration ? preparedBefore.port : deps.requestedPort
      ?? (preparedBefore ? await availablePort() : config.ferry?.port || await availablePort());
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('FERRY 端口配置无效');
    await mkdir(generation, { recursive: true, mode: 0o700 });
    const dataHome = join(generation, 'data');
    const stale = await readJson(join(dataHome, 'runtime.json'), null);
    if (stale?.pid) {
      let alive = false;
      try { process.kill(stale.pid, 0); alive = true; } catch {}
      if (alive) {
        const candidate = await readJson(join(generation, 'prepared.json'), null);
        if (candidate?.sourceHash === target.sha256 && candidate.policyHash === policyHash
          && candidate.adapterRevision === INSTRUMENTATION_REVISION
          && candidate.dataHome === dataHome && candidate.port === stale.port
          && digest(await readFile(candidate.program, 'utf8')) === candidate.programHash) {
          const observed = await managedRuntimeStatus(home, { ...deps, prepared: candidate });
          if (observed.ready) {
            await deps.beforePublish?.();
            await atomicJson(recordPath(home), candidate);
            return observed;
          }
        }
        throw new Error('已有 FERRY 候选进程尚未恢复就绪，旧版本保留，未启动重复实例');
      }
    }
    await assertFreePort(port);
    const source = await readFile(installed.entry, 'utf8');
    const instrumented = instrumentRuntime(source);
    if (instrumented.upstreamVersion !== target.version) throw new Error('FERRY 运行文件与安装版本不一致，未切换运行时');
    const program = join(generation, 'cli.botmux.mjs');
    await writeFile(program, instrumented.code, { mode: 0o700 });
    await writeFile(join(generation, 'botmux-policy.mjs'), policy, { mode: 0o600 });
    await chmod(program, 0o700);
    await mkdir(dataHome, { recursive: true, mode: 0o700 });
    const prepared = { sourceHash: target.sha256, version: target.version,
      program, programHash: digest(instrumented.code), policyHash: digest(policy.toString('utf8')),
      adapterRevision: INSTRUMENTATION_REVISION, controlProtocol: 1,
      packageRoot: installed.packageRoot, dataHome, port, sdkDirectory };
    await atomicJson(join(generation, 'prepared.json'), prepared);
    const log = await open(join(generation, 'runtime.log'), 'a', 0o600);
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('BOTMUX_')));
    Object.assign(env, {
      FERRY_HOME: dataHome, FERRY_PORT: String(port), BOTMUX_FERRY_CONTROL_HOME: home,
    });
    const child = spawn(runtime.node, [program, '__daemon', '--port', String(port)], {
      env, detached: true, stdio: ['ignore', log.fd, log.fd], cwd: generation, shell: false,
    });
    let failed = false;
    child.once('error', () => { failed = true; });
    child.unref();
    await log.close();
    let observed;
    for (let attempt = 0; attempt < 100; attempt++) {
      const ready = await managedRuntimeStatus(home, { ...deps, prepared });
      observed = ready;
      if (ready.ready) {
        // Publish only after the serving daemon, authentication and SDK pass.
        try { await deps.beforePublish?.(); }
        catch (error) {
          if (!ready.activeRequests && child.pid === ready.pid) child.kill('SIGTERM');
          throw error;
        }
        await atomicJson(recordPath(home), prepared);
        return ready;
      }
      if (failed || child.exitCode !== null || child.signalCode !== null) break;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    // A responding but still authenticating daemon is not a crashed startup.
    // Keep it alive; report its distinct health instead of cancelling requests.
    if (observed?.online && !current.online && !deps.requireReadyBeforePublish) {
      await deps.beforePublish?.();
      await atomicJson(recordPath(home), prepared);
      return observed;
    }
    if (observed?.online) throw new Error('FERRY 新运行环境尚未通过认证，旧话题及旧运行版本保留');
    if (child.pid && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    throw new Error('FERRY 受管运行时尚未就绪；请查看插件私有运行日志，不会切换 Bot 线路');
  });
}

export async function gatewayModels(home, deps = {}) {
  const status = await managedRuntimeStatus(home, deps);
  if (status.online) {
    const prepared = await readJson(recordPath(home));
    const runtime = await readJson(join(prepared.dataHome, 'runtime.json'));
    return ferryAdmin(runtime, 'models', deps.fetcher);
  }
  const installed = await (deps.detectFerry || detectFerry)(home);
  if (!installed) return [];
  const dataHome = installed.dataHome || process.env.FERRY_HOME
    || (process.platform === 'darwin' ? join(homedir(), 'Library/Application Support/ferry')
      : join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'ferry'));
  const runtime = await readJson(join(dataHome, 'runtime.json'), null);
  if (!runtime) return [];
  try {
    await ferryAdmin(runtime, 'status', deps.fetcher);
    const models = await ferryAdmin(runtime, 'models', deps.fetcher);
    return Array.isArray(models) ? models : [];
  } catch { return []; }
}
