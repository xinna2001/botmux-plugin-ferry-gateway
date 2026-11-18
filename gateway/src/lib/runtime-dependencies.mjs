import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, readFile, readlink, realpath, rename, symlink, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJson, readJson } from '../../../shared/state.mjs';

const execute = promisify(execFile);
const SDK = '@bytedance-dev/bytecloud-auth-sdk';
const root = home => join(home, 'plugins/gateway-acceleration/private/runtime');
const linksFile = home => join(root(home), 'dependencies.json');
const missing = error => error.code === 'ENOENT';
const statOrNull = file => lstat(file).catch(error => { if (missing(error)) return null; throw error; });

// Resolve the package directory, not its require export. ESM import can have a
// different export condition. A per-package link preserves the original package's
// own dependency tree and also works when npm nests this SDK under @ad/ferry.
async function sdkDirectory(installed) {
  if (!installed?.entry || !installed.packageRoot) throw new Error('FERRY 依赖安装位置不可用');
  const require = createRequire(installed.entry);
  const ancestors = new Set();
  for (let cursor = dirname(installed.entry); ; cursor = dirname(cursor)) {
    ancestors.add(join(cursor, 'node_modules'));
    if (dirname(cursor) === cursor) break;
  }
  for (const base of (require.resolve.paths(SDK) || []).filter(base => ancestors.has(base))) {
    const candidate = join(base, SDK);
    try {
      const metadata = JSON.parse(await readFile(join(candidate, 'package.json'), 'utf8'));
      if (metadata.name === SDK) return await realpath(candidate);
    } catch (error) { if (!missing(error)) throw error; }
  }
  throw new Error('FERRY 安装中缺少 ByteCloud 登录依赖，请重新准备依赖');
}

export async function runtimeDependencyStatus(home, installed, options = {}) {
  try {
    const expected = await sdkDirectory(installed);
    const actual = await realpath(join(options.directory || root(home), 'node_modules', SDK));
    if (actual !== expected) return { ready: false, code: 'dependency_conflict',
      message: 'FERRY 登录依赖指向其他安装，未覆盖；请检查运行时依赖' };
    return { ready: true };
  } catch (error) {
    return { ready: false, code: missing(error) ? 'dependency_missing' : 'dependency_invalid',
      message: 'FERRY 运行时登录依赖缺失或不可解析，请点击修复依赖；无需反复登录' };
  }
}

export async function ensureRuntimeDependencies(home, installed, runtime, deps = {}) {
  const expected = await sdkDirectory(installed);
  const directory = deps.directory || root(home), modules = join(directory, 'node_modules'), target = join(modules, SDK);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const recordFile = deps.directory ? join(directory, 'dependencies.json') : linksFile(home);
  const previous = await readJson(recordFile, {});
  const modulesStat = await statOrNull(modules);
  if (modulesStat?.isSymbolicLink()) {
    // Preserve a user's already-working whole-node_modules link. Never write
    // through it into the original/global dependency tree.
    if ((await runtimeDependencyStatus(home, installed, deps)).ready) {
      await verifyImport(directory, runtime, deps);
      return { ready: true, repaired: false };
    }
    const oldTarget = await readlink(modules);
    const absolute = resolve(directory, oldTarget);
    const dangling = !await statOrNull(absolute);
    const knownPrivate = absolute.startsWith(join(home, 'local/ferry-plugin-dependency') + '/')
      && absolute.endsWith('/node_modules');
    if (!dangling || !knownPrivate) throw new Error('FERRY 运行时存在其他依赖软链，未覆盖；请检查运行时依赖');
    // A dangling old private-install link is safe to replace, with the link
    // itself retained as a private backup. Never remove its former target.
    await rename(modules, join(directory, `node_modules.broken-${randomUUID()}`));
  } else if (modulesStat && !modulesStat.isDirectory()) {
    throw new Error('FERRY 运行时依赖目录被其他文件占用，未覆盖');
  }
  const scope = join(modules, '@bytedance-dev');
  const scopeStat = await statOrNull(scope);
  if (scopeStat && (!scopeStat.isDirectory() || scopeStat.isSymbolicLink())) {
    throw new Error('FERRY 登录依赖命名空间被其他内容占用，未覆盖');
  }
  await mkdir(scope, { recursive: true, mode: 0o700 });
  const existing = await statOrNull(target);
  let repaired = false;
  if (existing) {
    const actual = await realpath(target).catch(error => { if (missing(error)) return null; throw error; });
    if (actual !== expected) {
      const linkTarget = existing.isSymbolicLink() ? await readlink(target) : null;
      if (!existing.isSymbolicLink() || linkTarget !== previous.sdkTarget) {
        throw new Error('FERRY 登录依赖已有非受管内容，未覆盖；请检查运行时依赖');
      }
      const stage = `${target}.${randomUUID()}.tmp`;
      try {
        await symlink(expected, stage, 'dir');
        await rename(stage, target);
      } finally { await unlink(stage).catch(error => { if (!missing(error)) throw error; }); }
      repaired = true;
    }
  } else {
    await symlink(expected, target, 'dir');
    repaired = true;
  }
  // The actual dynamic ESM import is the acceptance test, not NODE_PATH or a
  // successful require.resolve in the original installation.
  await verifyImport(directory, runtime, deps);
  await atomicJson(recordFile, { schemaVersion: 1, sdkTarget: expected });
  return { ready: true, repaired };
}

async function verifyImport(cwd, runtime, deps) {
  if (!runtime?.node) throw new Error('FERRY 运行时缺少可用 Node.js');
  const code = `const m=await import(${JSON.stringify(SDK)});if(typeof (m.createByteCloudAuthClient||m.default?.createByteCloudAuthClient)!=="function")throw new Error("invalid auth SDK");`;
  try {
    await (deps.run || execute)(runtime.node, ['--input-type=module', '--eval', code], {
      cwd, timeout: 10000, maxBuffer: 16384, shell: false,
      env: { ...process.env, NODE_PATH: '' },
    });
  } catch {
    throw new Error('FERRY 运行时无法加载 ByteCloud 登录依赖，请修复依赖；这不是账号未登录');
  }
}
