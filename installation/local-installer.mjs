import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { createInstallationFlow } from './flow.mjs';
import { homePath, readJson, digest, withLock } from '../shared/state.mjs';
import { setupStatus } from '../gateway/src/lib/setup.mjs';
import { runtimeStatus } from '../gateway/src/lib/runtime.mjs';

const exec = promisify(execFile);
const packageDir = resolve(import.meta.dirname, '../gateway');
const ID = 'gateway-acceleration';
const options = { timeout: 15000, maxBuffer: 1024 * 1024, shell: false };
async function registryRevision(home) {
  let value = 'absent';
  try {
    const metadata = await stat(join(home, 'plugins-registry.json'), { bigint: true });
    value = [metadata.dev, metadata.ino, metadata.size, metadata.mtimeNs, metadata.ctimeNs].join(':');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return createHash('sha256').update(value).digest('hex');
}
export function createLocalInstaller(home = homePath(), overrides = {}) {
  if (!overrides.run && resolve(home) !== join(homedir(), '.botmux')) throw new Error('非默认配置目录需要显式安装适配器');
  const run = overrides.run || exec;
  const setup = () => (overrides.setup || setupStatus)(home);
  const installedRecord = async () => (await readJson(join(home, 'plugins-registry.json'))).plugins?.[ID];
  const authority = async () => digest((await readFile(join(home, '.dashboard-token'), 'utf8')).trim());
  return createInstallationFlow({
    lock: fn => withLock(join(home, 'plugin-installer', ID), fn),
    snapshot: async () => digest({
      registry: await registryRevision(home),
      package: await readJson(join(packageDir, 'package.json')), authority: await authority(),
    }),
    check: async step => {
      if (step === 'environment') {
        try {
          const value = await (overrides.runtime || runtimeStatus)(home);
          return { ok: value.ready, message: value.ready ? `Node ${value.version} · npm 已就绪` : '需要补足 Node.js 与 npm' };
        } catch { return { ok: false, message: '需要 Node.js 22 或更高版本及 npm' }; }
      }
      if (step === 'dependency') {
        const value = await setup();
        return { ok: value.installed, message: value.installed ? `复用 FERRY ${value.version}` : '尚未安装 FERRY，请先确认准备依赖' };
      }
      if (step === 'identity') {
        const value = await setup();
        return { ok: value.authenticated === true, message: value.authenticated ? '本人内部登录已就绪' : '请先完成本人 FERRY 登录' };
      }
      throw new Error('未知安装步骤');
    },
    install: async () => {
      const pkg = await readJson(join(packageDir, 'package.json'));
      const current = await installedRecord();
      const guard = {
        id: ID, packageName: pkg.name, version: pkg.version,
        expectedState: current ? digest(current) : null,
        expectedRevision: await registryRevision(home), authorityDigest: await authority(),
      };
      await run('botmux', ['plugin', 'install-verified', packageDir, '--guard-json', JSON.stringify(guard)], {
        ...options, timeout: 180000,
      });
      const actual = await installedRecord();
      if (actual?.packageName !== pkg.name || actual?.version !== pkg.version) throw new Error('安装结果未通过核验');
      return { pluginId: ID, enabledAutomatically: false };
    },
  });
}
