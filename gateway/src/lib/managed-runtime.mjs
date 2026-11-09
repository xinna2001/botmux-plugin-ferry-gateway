import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, open, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { atomicJson, digest, readJson, withLock } from '../../../shared/state.mjs';
import { detectFerry, setupStatus } from './setup.mjs';
import { detectRuntime } from './runtime.mjs';
import { instrumentRuntime, supportedRuntime } from './runtime-instrument.mjs';

const rootPath = home => join(home, 'plugins/gateway-acceleration/private/runtime');
const recordPath = home => join(rootPath(home), 'prepared.json');
const recoveries = new Map();

export async function recoverManagedRuntime(home, deps = {}) {
  if (recoveries.has(home)) return recoveries.get(home);
  const pending = (async () => {
    const config = await readJson(join(home, 'plugins/gateway-acceleration/config.json'));
    if (config.controlPlane?.runtimeWanted !== true) return;
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
  const prepared = await readJson(recordPath(home), null);
  if (!prepared || prepared.sourceHash !== supportedRuntime.sha256) return { online: false };
  const runtime = await readJson(join(prepared.dataHome, 'runtime.json'), null);
  if (!runtime || runtime.port !== prepared.port) return { online: false };
  try {
    const status = await ferryAdmin(runtime, 'status', deps.fetcher);
    return { online: true, port: runtime.port, pid: runtime.pid,
      version: String(status.version), activeRequests: status.active_requests };
  } catch { return { online: false }; }
}

async function assertFreePort(port) {
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', () => reject(new Error('FERRY 端口已被占用，未停止或替换已有服务')));
    server.listen(port, '127.0.0.1', () => server.close(error => error ? reject(error) : resolve()));
  });
}

export async function ensureManagedRuntime(home, deps = {}) {
  await mkdir(rootPath(home), { recursive: true, mode: 0o700 });
  return withLock(join(rootPath(home), 'operation'), async () => {
    const current = await managedRuntimeStatus(home, deps);
    if (current.online) return current;
    const installed = await (deps.detectFerry || detectFerry)(home);
    if (!installed || installed.version !== supportedRuntime.version) {
      throw new Error(`需要已核验的 FERRY ${supportedRuntime.version} 运行时；不会覆盖或降级已有全局安装`);
    }
    const authenticated = await (deps.setupStatus || setupStatus)(home);
    if (!authenticated.authenticated) throw new Error('请先完成本人内部登录');
    const runtime = await (deps.detectRuntime || detectRuntime)(home);
    if (!runtime) throw new Error('请先补足 Node.js 运行环境');
    const config = await readJson(join(home, 'plugins/gateway-acceleration/config.json'));
    const port = config.ferry?.port || 18790;
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('FERRY 端口配置无效');
    const dataHome = join(rootPath(home), 'data');
    const stale = await readJson(join(dataHome, 'runtime.json'), null);
    if (stale?.pid) {
      let alive = false;
      try { process.kill(stale.pid, 0); alive = true; } catch {}
      if (alive) throw new Error('已有 FERRY 进程尚未恢复就绪，未启动重复实例');
    }
    await assertFreePort(port);
    const source = await readFile(installed.entry, 'utf8');
    const instrumented = instrumentRuntime(source);
    const policy = await readFile(deps.policyFile || fileURLToPath(new URL('../runtime/policy.mjs', import.meta.url)));
    const program = join(rootPath(home), 'cli.botmux.mjs');
    await writeFile(program, instrumented.code, { mode: 0o700 });
    await writeFile(join(rootPath(home), 'botmux-policy.mjs'), policy, { mode: 0o600 });
    await chmod(program, 0o700);
    await mkdir(dataHome, { recursive: true, mode: 0o700 });
    const prepared = { sourceHash: supportedRuntime.sha256, version: supportedRuntime.version,
      program, programHash: digest(instrumented.code), policyHash: digest(policy.toString('utf8')),
      packageRoot: installed.packageRoot, dataHome, port };
    await atomicJson(recordPath(home), prepared);
    const log = await open(join(rootPath(home), 'runtime.log'), 'a', 0o600);
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('BOTMUX_')));
    Object.assign(env, {
      FERRY_HOME: dataHome, FERRY_PORT: String(port), BOTMUX_FERRY_CONTROL_HOME: home,
      NODE_PATH: dirname(dirname(installed.packageRoot)),
    });
    const child = spawn(runtime.node, [program, '__daemon', '--port', String(port)], {
      env, detached: true, stdio: ['ignore', log.fd, log.fd], cwd: rootPath(home), shell: false,
    });
    let failed = false;
    child.once('error', () => { failed = true; });
    child.unref();
    await log.close();
    for (let attempt = 0; attempt < 100; attempt++) {
      const ready = await managedRuntimeStatus(home, deps);
      if (ready.online) return ready;
      if (failed || child.exitCode !== null || child.signalCode !== null) break;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
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
