import { mkdtemp, readFile, mkdir, rename, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { atomicJson, homePath, readJson, withLock } from '../../../shared/state.mjs';
import { runWithRuntime } from './runtime.mjs';
import { detectFerry } from './setup.mjs';
import { supportedRuntimes, instrumentRuntime, sourceRuntime } from './runtime-instrument.mjs';
import { ensureManagedRuntime } from './managed-runtime.mjs';
import { managementAuthority, assertManagementAuthority } from './host-control.mjs';
import { invalidatePreparation } from './preparation-cache.mjs';
import { queryLatestVersion } from './version-check.mjs';

const packageName = '@ad/ferry', registry = 'https://bnpm.byted.org';
const semver = /^\d+\.\d+\.\d+$/;
const options = { timeout: 120000, maxBuffer: 1024 * 1024, shell: false };
export function compareVersion(a, b) {
  if (!semver.test(a || '') || !semver.test(b || '')) throw new Error('FERRY 版本格式无法核验');
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return Math.sign(left[i] - right[i]);
  return 0;
}
export async function checkAndUpdate(home = homePath(), deps = {}, job = {}, requestedVersion) {
  const authority = await managementAuthority(home);
  const execute = deps.run || ((command, args, opts) => runWithRuntime(command, args, opts, home));
  const serving = await readJson(join(home, 'plugins/gateway-acceleration/private/runtime/prepared.json'), null);
  const preferred = sourceRuntime(serving?.sourceHash, serving?.version)?.version;
  const detect = deps.detectFerry || detectFerry;
  const selectCurrent = async () => (preferred ? await detect(home, { compatibleOnly: true, targetVersion: preferred }) : null)
    || await detect(home);
  const current = await selectCurrent();
  const checkpoint = (completed, message) => {
    job.progress = message; job.completedSteps = completed; job.totalSteps = 5; job.percent = completed * 20;
  };
  checkpoint(0, '正在确认要更新的 FERRY 版本');
  const latest = await queryLatestVersion(home, deps);
  const metadata = { version: latest.latestVersion, 'dist.integrity': latest.integrity };
  if (requestedVersion && requestedVersion !== metadata.version) throw new Error('FERRY 最新版本已变化，请重新检查后再更新');
  if (!metadata['dist.integrity']) {
    throw new Error('FERRY 最新版本或安装包完整性无法核验');
  }
  if (current && compareVersion(metadata.version, current.version) <= 0) {
    job.progress = `已是最新版 · FERRY ${current.version}`;
    checkpoint(5, job.progress);
    return { updated: false, version: current.version };
  }
  // A package being newer is not evidence of protocol/AST compatibility.
  if (!supportedRuntimes[metadata.version]) {
    throw new Error(`FERRY 最新版 ${metadata.version} 尚未通过此插件的兼容性验证，保留原版本 ${current?.version || '未安装'}`);
  }
  checkpoint(1, `已确认 FERRY ${metadata.version}；正在下载并校验安装包`);
  const base = join(home, 'local/ferry-plugin-dependency');
  await mkdir(base, { recursive: true, mode: 0o700 });
  return withLock(join(base, 'operation'), async () => {
    await assertManagementAuthority(home, authority);
    const before = await selectCurrent();
    if (JSON.stringify(before) !== JSON.stringify(current)) throw new Error('FERRY 安装状态已变化，请重新检查更新');
    const stage = await mkdtemp(join(base, '.update-'));
    let destination, installedCommitted = false;
    const pointerFile = join(base, 'installed.json');
    const preparedFile = join(home, 'plugins/gateway-acceleration/private/runtime/prepared.json');
    const oldPointer = await readJson(pointerFile, null), oldPrepared = await readJson(preparedFile, null);
    try {
      const result = await execute('npm', ['pack', `${packageName}@${metadata.version}`, '--ignore-scripts',
        '--json', '--pack-destination', stage, `--registry=${registry}`], options);
      const filename = JSON.parse(result.stdout)?.[0]?.filename;
      if (!filename || basename(filename) !== filename || !filename.endsWith('.tgz')) throw new Error('FERRY 安装包文件名无效');
      const archive = join(stage, filename);
      const bytes = await readFile(archive);
      if (`sha512-${createHash('sha512').update(bytes).digest('base64')}` !== metadata['dist.integrity']) throw new Error('FERRY 安装包完整性不匹配');
      checkpoint(2, '安装包完整性已通过；正在安装和校验源码');
      await execute('npm', ['install', '--prefix', stage, '--ignore-scripts', '--omit=dev', '--no-audit',
        '--no-fund', `file:${archive}`, `--registry=${registry}`], options);
      const pkg = await readJson(join(stage, 'node_modules/@ad/ferry/package.json'));
      if (pkg.name !== packageName || pkg.version !== metadata.version) throw new Error('FERRY 安装包身份不匹配');
      const verified = instrumentRuntime(await readFile(join(stage, 'node_modules/@ad/ferry/dist/cli.js'), 'utf8'));
      if (verified.upstreamVersion !== metadata.version) throw new Error('FERRY 源码版本与安装包身份不一致');
      checkpoint(3, '源码身份已通过；正在验证启动、本人认证、SDK 与模型目录');
      destination = join(base, `${metadata.version}-${Date.now()}`);
      await rename(stage, destination);
      const candidate = { version: metadata.version, entry: join(destination, 'node_modules/@ad/ferry/dist/cli.js'),
        packageRoot: join(destination, 'node_modules/@ad/ferry'), source: 'managed', dataHome: current?.dataHome };
      job.progress = '正在验证新版启动、本人认证、SDK 与模型目录；旧话题网关保持运行';
      const runtime = await (deps.ensureManagedRuntime || ensureManagedRuntime)(home, {
        ...deps, targetVersion: candidate.version, detectFerry: async () => candidate,
      });
      if (!runtime.ready) throw new Error('FERRY 新版启动或认证未通过，保留旧版和旧话题线路');
      checkpoint(4, '新版启动、认证、SDK 与模型目录已通过；正在切换新话题默认版本');
      await assertManagementAuthority(home, authority);
      // Keep the actual directory in the pointer: no overwrite of old installs.
      await atomicJson(pointerFile, { version: metadata.version, directory: destination });
      installedCommitted = true;
      await invalidatePreparation(home);
      checkpoint(5, `更新完成 · FERRY ${metadata.version}；仅新话题采用新版`);
      return { updated: true, version: metadata.version };
    } catch (error) {
      // Roll back only pointers, never stop an old daemon or delete its files.
      if (!installedCommitted) {
        if (oldPrepared) await atomicJson(preparedFile, oldPrepared);
        if (oldPointer) await atomicJson(pointerFile, oldPointer);
      }
      throw error;
    } finally {
      await rm(stage, { recursive: true, force: true });
      // A candidate may have a running daemon: retain it for diagnosis rather
      // than deleting code from beneath an active process.
    }
  });
}
