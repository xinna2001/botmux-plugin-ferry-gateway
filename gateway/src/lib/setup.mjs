import { readFile, access, mkdtemp, rm, rename, readdir } from 'node:fs/promises';
import { join, isAbsolute, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { homePath, readJson, atomicJson, withLock, pluginConfig, digest } from '../../../shared/state.mjs';
import { PLUGIN_ID, loadProfiles } from './gateway.mjs';
import { runWithRuntime } from './runtime.mjs';

const PACKAGE = '@ad/ferry';
const REGISTRY = 'https://bnpm.byted.org';
const VERSION = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/;
const options = { timeout: 120000, maxBuffer: 1024 * 1024, shell: false };
const root = home => join(home, 'local', 'ferry-plugin-dependency');
const plans = new Map();
const jobs = new Map();
const jobView = job => job ? { state: job.state, operation: job.operation, error: job.error } : null;
const authority = async home => {
  const token = (await readFile(join(home, '.dashboard-token'), 'utf8')).trim();
  if (!token) throw new Error('本机管理身份不可用');
  return digest(token);
};

export async function detectFerry(home = homePath(), deps = {}) {
  const execute = deps.run || ((command, args, opts) => runWithRuntime(command, args, opts, home));
  const config = await readJson(pluginConfig(PLUGIN_ID, home));
  const candidates = [];
  if (isAbsolute(config.ferry?.packageRoot || '')) candidates.push({ packageRoot: config.ferry.packageRoot, dataHome: config.ferry.dataHome, source: 'configured' });
  const managed = await readJson(join(root(home), 'installed.json'), null);
  if (managed && VERSION.test(managed.version)) candidates.push({
    packageRoot: join(root(home), managed.version, 'node_modules/@ad/ferry'),
    dataHome: join(root(home), 'data'), source: 'managed',
  });
  for (const profile of await loadProfiles(home)) candidates.push({
    packageRoot: join(home, 'local', profile.id, 'node_modules/@ad/ferry'),
    dataHome: join(home, 'local', profile.id, 'data'), source: 'existing',
  });
  const local = await readdir(join(home, 'local'), { withFileTypes: true }).catch(() => []);
  for (const entry of local.filter(entry => entry.isDirectory()).slice(0, 100)) candidates.push({
    packageRoot: join(home, 'local', entry.name, 'node_modules/@ad/ferry'),
    dataHome: join(home, 'local', entry.name, 'data'), source: 'existing',
  });
  try {
    const { stdout } = await execute('npm', ['root', '-g'], { ...options, timeout: 5000 });
    if (isAbsolute(stdout.trim())) candidates.push({ packageRoot: join(stdout.trim(), '@ad/ferry'), source: 'global' });
  } catch {}
  for (const item of candidates) {
    try {
      const pkg = await readJson(join(item.packageRoot, 'package.json'));
      if (pkg.name !== PACKAGE || !VERSION.test(pkg.version)) continue;
      await access(join(item.packageRoot, 'dist/cli.js'));
      return { ...item, version: pkg.version, entry: join(item.packageRoot, 'dist/cli.js') };
    } catch {}
  }
  return null;
}
function ferryEnv(installed) {
  const env = { ...process.env };
  if (installed.dataHome) env.FERRY_HOME = installed.dataHome;
  return env;
}
export async function setupStatus(home = homePath(), deps = {}) {
  const installed = await detectFerry(home, deps);
  if (!installed) return { installed: false, authenticated: false, online: false, job: jobView(jobs.get(home)) };
  try {
    const { stdout } = await (deps.run || ((command, args, opts) => runWithRuntime(command, args, opts, home)))('node', [installed.entry, 'status', '--json'], { ...options, env: ferryEnv(installed), timeout: 8000 });
    const value = JSON.parse(stdout);
    const authenticated = value.bytecloud?.authenticated === true
      || (['traecli', 'bytecloud'].includes(value.daemon?.status?.auth?.source)
        && Date.parse(value.daemon.status.auth.expiresAt) > Date.now());
    return {
      installed: true, version: installed.version, source: installed.source,
      authenticated, online: value.daemon?.state === 'running',
      activeRequests: Number.isInteger(value.daemon?.status?.active_requests) ? value.daemon.status.active_requests : null,
      port: Number.isInteger(value.daemon?.runtime?.port) ? value.daemon.runtime.port : null,
      job: jobView(jobs.get(home)),
    };
  } catch { return { installed: true, version: installed.version, source: installed.source, authenticated: false, online: false, statusError: '网关状态暂不可查询', job: jobView(jobs.get(home)) }; }
}
export async function prepareInstall(home = homePath(), deps = {}) {
  if (await detectFerry(home, deps)) throw new Error('已经检测到 FERRY，将复用现有安装');
  let nodeVersion;
  const execute = deps.run || ((command, args, opts) => runWithRuntime(command, args, opts, home));
  try { nodeVersion = (await execute('node', ['--version'], options)).stdout.trim(); }
  catch { throw new Error('需要安装 Node.js 22 和 npm 后重试'); }
  if (!/^v(\d+)\./.test(nodeVersion) || Number(/^v(\d+)\./.exec(nodeVersion)[1]) < 22) throw new Error('需要 Node.js 22 或更高版本');
  const { stdout } = await execute('npm', ['view', PACKAGE, 'version', 'dist.integrity', '--json', `--registry=${REGISTRY}`], { ...options, timeout: 15000 });
  const value = JSON.parse(stdout);
  if (!VERSION.test(value.version) || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(value['dist.integrity'] || '')) throw new Error('无法核验内网安装包');
  for (const [key, plan] of plans) if (plan.expiresAt < Date.now()) plans.delete(key);
  if (plans.size >= 20) throw new Error('已有过多安装确认，请稍后重试');
  const plan = {
    nonce: randomUUID(), version: value.version, integrity: value['dist.integrity'],
    expiresAt: Date.now() + 300000, authority: await authority(home), home,
  };
  plans.set(plan.nonce, plan);
  return { nonce: plan.nonce, packageName: PACKAGE, version: plan.version, integrity: plan.integrity, registry: REGISTRY, expiresAt: plan.expiresAt };
}
export async function installFerry({ nonce, confirm }, home = homePath(), deps = {}) {
  const plan = plans.get(nonce);
  if (!plan || plan.home !== home || confirm !== true || plan.expiresAt <= Date.now() || plan.authority !== await authority(home)) throw new Error('安装确认已失效');
  if (plans.get(nonce) !== plan || plan.expiresAt <= Date.now()) throw new Error('安装确认已失效');
  plans.delete(nonce);
  return withLock(join(root(home), 'operation'), async () => {
    if (await detectFerry(home, deps)) throw new Error('已存在 FERRY，已取消重复安装');
    const execute = deps.run || ((command, args, opts) => runWithRuntime(command, args, opts, home));
    const temp = await mkdtemp(join(tmpdir(), 'botmux-ferry-install-'));
    const destination = join(root(home), plan.version);
    let staged;
    try {
      const { stdout } = await execute('npm', ['pack', `${PACKAGE}@${plan.version}`, '--ignore-scripts', '--json', '--pack-destination', temp, `--registry=${REGISTRY}`], options);
      const filename = JSON.parse(stdout)?.[0]?.filename;
      if (typeof filename !== 'string' || basename(filename) !== filename || !filename.endsWith('.tgz')) throw new Error('安装包格式无效');
      const archive = join(temp, filename);
      const hash = 'sha512-' + createHash('sha512').update(await readFile(archive)).digest('base64');
      if (hash !== plan.integrity) throw new Error('安装包完整性不匹配');
      const metadata = JSON.parse((await execute('tar', ['-xOf', archive, 'package/package.json'], options)).stdout);
      if (metadata.name !== PACKAGE || metadata.version !== plan.version) throw new Error('安装包身份不匹配');
      if (plan.authority !== await authority(home)) throw new Error('安装授权已失效');
      staged = await mkdtemp(join(root(home), '.staging-'));
      await execute('npm', ['install', '--prefix', staged, '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', `file:${archive}`, `--registry=${REGISTRY}`], options);
      const pkg = await readJson(join(staged, 'node_modules/@ad/ferry/package.json'));
      if (pkg.name !== PACKAGE || pkg.version !== plan.version) throw new Error('安装结果核验失败');
      await access(join(staged, 'node_modules/@ad/ferry/dist/cli.js'));
      if (plan.authority !== await authority(home) || await detectFerry(home, deps)) throw new Error('环境已变化，已取消安装');
      await rename(staged, destination);
      try { await atomicJson(join(root(home), 'installed.json'), { version: plan.version }); }
      catch (error) { await rename(destination, staged); throw error; }
      staged = undefined;
      return setupStatus(home, deps);
    } finally {
      await rm(temp, { recursive: true, force: true });
      if (staged) await rm(staged, { recursive: true, force: true });
    }
  });
}
export function startJob(operation, action, home = homePath()) {
  if (jobs.get(home)?.state === 'running') throw new Error('已有安装或连接操作进行中');
  const job = { operation, state: 'running' };
  jobs.set(home, job);
  Promise.resolve().then(action).then(() => { job.state = 'complete'; }).catch(() => {
    job.state = 'failed'; job.error = '操作未完成；请检查内网连接、本人登录或依赖状态后重试';
  });
  return jobView(job);
}
export function getJobStatus(home = homePath()) { return jobView(jobs.get(home)); }
export async function connectFerry({ action, confirm }, home = homePath(), deps = {}) {
  if (confirm !== true || !['login', 'connect', 'disconnect'].includes(action)) throw new Error('需要明确确认');
  const installed = await detectFerry(home, deps);
  if (!installed) throw new Error('请先安装 FERRY');
  const status = await setupStatus(home, deps);
  if (action === 'connect' && status.online) return status;
  if (action === 'connect' && !status.authenticated) throw new Error('请先完成本人登录');
  // Existing installations keep their own ports and supervision; no restart or stop is invoked.
  if (action === 'connect' && installed.source !== 'managed') throw new Error('现有网关由原有进程管理，请从原入口启动');
  if (action === 'disconnect' && (installed.source !== 'managed' || status.activeRequests !== 0)) throw new Error('只能断开插件管理且没有在途请求的网关');
  const args = action === 'login' ? ['login'] : action === 'disconnect' ? ['stop'] : ['start'];
  if (action === 'connect') {
    const config = await readJson(pluginConfig(PLUGIN_ID, home));
    const port = config.ferry?.port ?? 18790;
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('请先设置一个未被占用的本机端口');
    args.push('--port', String(port));
  }
  await (deps.run || ((command, args, opts) => runWithRuntime(command, args, opts, home)))('node', [installed.entry, ...args], { ...options, timeout: 300000, env: ferryEnv(installed) });
  const result = await setupStatus(home, deps);
  if (action === 'login' && !result.authenticated) throw new Error('本人登录尚未完成');
  if (action === 'connect' && !result.online) throw new Error('网关尚未成功启动');
  if (action === 'disconnect' && result.online) throw new Error('网关尚未成功停止');
  return result;
}
export async function connectionConfig(home = homePath(), deps = {}) {
  const installed = await detectFerry(home, deps);
  if (!installed) throw new Error('请先安装 FERRY');
  if (!(await setupStatus(home, deps)).online) throw new Error('请先连接网关，再生成实际接入配置');
  const value = await (deps.run || ((command, args, opts) => runWithRuntime(command, args, opts, home)))('node', [installed.entry, 'config', 'codex'], { ...options, timeout: 10000, env: ferryEnv(installed) });
  // Official config output is returned only on an explicit management action.
  return { filename: 'ferry-codex.toml', content: value.stdout, applied: false };
}
