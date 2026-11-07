import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { homePath, withLock } from '../../../shared/state.mjs';

const exec = promisify(execFile);
const NODE_VERSION = '24.16.0';
const root = home => join(home, 'local', 'plugin-node-runtime');
const destination = home => join(root(home), NODE_VERSION);
const options = { timeout: 10000, maxBuffer: 1024 * 1024, shell: false };
const validNode = value => /^v(\d+)\./.test(value) && Number(value.match(/^v(\d+)/)[1]) >= 22;

export async function detectRuntime(home = homePath(), deps = {}) {
  const run = deps.run || exec;
  for (const command of [join(destination(home), 'bin/node'), process.execPath, 'node']) {
    try {
      const version = (await run(command, ['--version'], options)).stdout.trim();
      if (!validNode(version)) continue;
      const node = (await run(command, ['-p', 'process.execPath'], options)).stdout.trim();
      if (!node.startsWith('/')) continue;
      for (const npm of [join(dirname(node), '../lib/node_modules/npm/bin/npm-cli.js'), join(dirname(node), '../node_modules/npm/bin/npm-cli.js')]) {
        try {
          await (deps.access || access)(npm);
          await run(node, [npm, '--version'], options);
          return { node, npm, version };
        } catch {}
      }
    } catch {}
  }
  return null;
}
export async function runtimeStatus(home = homePath(), deps = {}) {
  const runtime = await detectRuntime(home, deps);
  return { ready: !!runtime, version: runtime?.version, repairAvailable: ['darwin', 'linux'].includes(process.platform) && ['arm64', 'x64'].includes(process.arch) };
}
export async function runWithRuntime(command, args, opts = {}, home = homePath()) {
  const runtime = await detectRuntime(home);
  if (!runtime) throw new Error('请先一键补足运行环境');
  const env = { ...process.env, ...opts.env, PATH: `${dirname(runtime.node)}:${opts.env?.PATH || process.env.PATH || ''}` };
  return exec(command === 'node' || command === 'npm' ? runtime.node : command,
    command === 'npm' ? [runtime.npm, ...args] : args, { ...opts, env });
}
async function download(url, limit, fetcher) {
  const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(120000) });
  if (!response.ok || Number(response.headers.get('content-length')) > limit) throw new Error('运行环境下载失败');
  const chunks = []; let size = 0;
  for await (const bytes of response.body) {
    size += bytes.length;
    if (size > limit) throw new Error('运行环境下载大小异常');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}
export async function installRuntime({ confirm }, home = homePath(), deps = {}) {
  if (confirm !== true) throw new Error('需要确认补足运行环境');
  return withLock(join(root(home), 'operation'), async () => {
    if (await detectRuntime(home, deps)) return runtimeStatus(home, deps);
    const platform = deps.platform || process.platform, arch = deps.arch || process.arch;
    if (!['darwin', 'linux'].includes(platform) || !['arm64', 'x64'].includes(arch)) throw new Error('当前系统不支持一键补足运行环境');
    const name = `node-v${NODE_VERSION}-${platform}-${arch}`;
    const filename = `${name}.tar.gz`, origin = `https://nodejs.org/dist/v${NODE_VERSION}/`;
    const fetcher = deps.fetcher || fetch;
    const sums = (await download(`${origin}SHASUMS256.txt`, 1024 * 1024, fetcher)).toString('utf8');
    const expected = sums.split('\n').map(line => /^([a-f0-9]{64})\s+(\S+)$/.exec(line)).find(match => match?.[2] === filename)?.[1];
    if (!expected) throw new Error('无法核验官方 Node.js 安装包');
    const archive = await download(`${origin}${filename}`, 80 * 1024 * 1024, fetcher);
    if (createHash('sha256').update(archive).digest('hex') !== expected) throw new Error('运行环境安装包完整性不匹配');
    await mkdir(root(home), { recursive: true, mode: 0o700 });
    const stage = await mkdtemp(join(root(home), '.staging-'));
    try {
      const file = join(stage, filename), extracted = join(stage, 'runtime');
      await writeFile(file, archive, { mode: 0o600 });
      await mkdir(extracted);
      const run = deps.run || exec;
      const names = (await run('tar', ['-tzf', file], options)).stdout.split('\n').filter(Boolean);
      if (!names.length || names.some(path => !path.startsWith(`${name}/`) || path.split('/').includes('..') || path.includes('\\'))) throw new Error('运行环境压缩包路径异常');
      await run('tar', ['-xzf', file, '--strip-components=1', '-C', extracted], options);
      const node = join(extracted, 'bin/node'), npm = join(extracted, 'lib/node_modules/npm/bin/npm-cli.js');
      if ((await run(node, ['--version'], options)).stdout.trim() !== `v${NODE_VERSION}`) throw new Error('运行环境版本核验失败');
      await run(node, [npm, '--version'], options);
      await rename(extracted, destination(home));
      return runtimeStatus(home, deps);
    } finally { await rm(stage, { recursive: true, force: true }); }
  });
}
