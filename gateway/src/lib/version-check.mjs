import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { randomUUID } from 'node:crypto';
import { atomicJson, homePath, readJson, withLock } from '../../../shared/state.mjs';
import { runWithRuntime } from './runtime.mjs';
import { sourceRuntime, supportedRuntimes } from './runtime-instrument.mjs';

const registry = 'https://bnpm.byted.org';
const packageName = '@ad/ferry';
const semver = /^\d+\.\d+\.\d+$/;
const file = home => join(home, 'plugins/gateway-acceleration/private/version-check.json');
const operation = home => join(home, 'plugins/gateway-acceleration/private/version-check-operation');
const integrityValid = value => /^sha512-[A-Za-z0-9+/]{86}==$/.test(value || '');

async function currentVersion(home) {
  const prepared = await readJson(join(home, 'plugins/gateway-acceleration/private/runtime/prepared.json'), null);
  return sourceRuntime(prepared?.sourceHash, prepared?.version)?.version;
}

export async function queryLatestVersion(home = homePath(), deps = {}) {
  let metadata;
  if (deps.run) {
    const result = await deps.run('npm', ['view', `${packageName}@latest`, 'version', 'dist.integrity',
      '--json', `--registry=${registry}`, '--fetch-retries=0', '--fetch-timeout=5000'],
    { timeout: 6000, maxBuffer: 1024 * 1024, shell: false });
    metadata = JSON.parse(result.stdout);
  } else {
    // A metadata-only, bounded request: no Node discovery, SDK checks, package
    // downloads, npm install or serving-generation changes during a check.
    const response = await (deps.fetcher || fetch)(`${registry}/@ad%2Fferry/latest`, {
      redirect: 'error', signal: AbortSignal.timeout(deps.timeoutMs || 6000),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error('FERRY 版本查询失败，请检查公司网络后重试');
    const text = await response.text();
    if (text.length > 1024 * 1024) throw new Error('FERRY 版本信息过大，未采用');
    metadata = JSON.parse(text);
  }
  if ((metadata.name && metadata.name !== packageName) || !semver.test(metadata.version || '')) {
    throw new Error('FERRY 最新版本信息无法核验');
  }
  const integrity = metadata.dist?.integrity || metadata['dist.integrity'];
  const current = await currentVersion(home);
  return { latestVersion: metadata.version, currentVersion: current, checkedAt: Date.now(),
    supported: !!supportedRuntimes[metadata.version], integrity: integrityValid(integrity) ? integrity : undefined,
    canUpdate: !!supportedRuntimes[metadata.version] && integrityValid(integrity) && current !== metadata.version };
}

export async function versionCheckStatus(home = homePath()) {
  const value = await readJson(file(home), null);
  if (value?.state === 'checking' && !await lockfile.check(operation(home), { realpath: false, stale: 30000 })) {
    return { ...value, state: 'failed', error: 'FERRY 版本检查已中断，请重新检查' };
  }
  return value;
}

export async function startVersionCheck(home = homePath(), deps = {}) {
  const existing = await versionCheckStatus(home);
  if (existing?.state === 'checking') return existing;
  let accept, reject;
  const started = new Promise((resolve, refuse) => { accept = resolve; reject = refuse; });
  void withLock(operation(home), async () => {
    const record = { id: randomUUID(), state: 'checking', startedAt: Date.now(),
      ...(existing?.state === 'complete' ? { previous: existing.result } : existing?.previous ? { previous: existing.previous } : {}) };
    await atomicJson(file(home), record);
    accept(record);
    try {
      record.result = await queryLatestVersion(home, deps);
      record.state = 'complete';
    } catch (error) {
      record.state = 'failed';
      record.error = /timeout|aborted/i.test(error.name)
        ? 'FERRY 版本检查超时，请检查公司网络后重试'
        : /^FERRY/.test(error.message) ? error.message : 'FERRY 版本查询失败，请检查公司网络后重试';
    }
    await atomicJson(file(home), record);
  }).catch(reject);
  return started;
}

export async function nativeVersionQuery(home, deps = {}) {
  // Explicit native-CLI fallback for registry deployments requiring npm auth;
  // use the owner's native configuration, never read or copy credential files.
  return queryLatestVersion(home, { ...deps, run: (command, args, options) =>
    runWithRuntime(command, args, options, home) });
}
