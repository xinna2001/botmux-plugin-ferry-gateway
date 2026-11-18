import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readlink, realpath, symlink, unlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { atomicJson, digest } from '../shared/state.mjs';
import { ensureRuntimeDependencies, runtimeDependencyStatus } from '../gateway/src/lib/runtime-dependencies.mjs';
import { ensureManagedRuntime, servingHealth } from '../gateway/src/lib/managed-runtime.mjs';
import { supportedRuntime, INSTRUMENTATION_REVISION } from '../gateway/src/lib/runtime-instrument.mjs';

const sdkName = '@bytedance-dev/bytecloud-auth-sdk';
async function fixture(t, nested = false) {
  const home = await mkdtemp(join(tmpdir(), 'ferry-dependencies-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const modules = join(home, 'dependency/node_modules');
  const packageRoot = join(modules, '@ad/ferry');
  const sdk = join(nested ? join(packageRoot, 'node_modules') : modules, sdkName);
  await mkdir(join(packageRoot, 'dist'), { recursive: true });
  await writeFile(join(packageRoot, 'dist/cli.js'), '// fixture, never executed\n');
  await mkdir(sdk, { recursive: true });
  await writeFile(join(sdk, 'package.json'), JSON.stringify({ name: sdkName, type: 'module', exports: './index.mjs' }));
  await writeFile(join(sdk, 'index.mjs'), 'export function createByteCloudAuthClient() { throw new Error("auth must not be called"); }\n');
  const directory = join(home, 'plugins/gateway-acceleration/private/runtime');
  const installed = { packageRoot, entry: join(packageRoot, 'dist/cli.js'), version: supportedRuntime.version };
  return { home, modules, sdk: await realpath(sdk), directory, installed, runtime: { node: process.execPath } };
}

test('private CLI can dynamically import the SDK without NODE_PATH, including nested npm layouts', async t => {
  for (const nested of [false, true]) {
    const f = await fixture(t, nested);
    assert.equal((await runtimeDependencyStatus(f.home, f.installed)).ready, false);
    assert.equal((await ensureRuntimeDependencies(f.home, f.installed, f.runtime)).ready, true);
    assert.equal(await realpath(join(f.directory, 'node_modules', sdkName)), f.sdk);
    assert.equal((await runtimeDependencyStatus(f.home, f.installed)).ready, true);
    await unlink(join(f.directory, 'node_modules', sdkName));
    assert.equal((await ensureRuntimeDependencies(f.home, f.installed, f.runtime)).repaired, true);
  }
});

test('a working manual whole-node_modules link is preserved without writing into its target', async t => {
  const f = await fixture(t);
  await mkdir(f.directory, { recursive: true });
  await symlink(f.modules, join(f.directory, 'node_modules'));
  const before = await readFile(join(f.sdk, 'package.json'), 'utf8');
  assert.equal((await ensureRuntimeDependencies(f.home, f.installed, f.runtime)).repaired, false);
  assert.equal(await readlink(join(f.directory, 'node_modules')), f.modules);
  assert.equal(await readFile(join(f.sdk, 'package.json'), 'utf8'), before);
});

test('a dangling old private-install root link is backed up and rebuilt', async t => {
  const f = await fixture(t);
  await mkdir(f.directory, { recursive: true });
  await symlink(join(f.home, 'local/ferry-plugin-dependency/old/node_modules'), join(f.directory, 'node_modules'));
  assert.equal((await ensureRuntimeDependencies(f.home, f.installed, f.runtime)).ready, true);
  assert.equal(await realpath(join(f.directory, 'node_modules', sdkName)), f.sdk);
});

test('unknown whole links, scope links and real SDK directories are not overwritten', async t => {
  for (const kind of ['root', 'scope', 'package']) {
    const f = await fixture(t);
    const target = join(f.directory, 'node_modules');
    await mkdir(target, { recursive: true });
    if (kind === 'root') {
      await rm(target, { recursive: true });
      await symlink(join(f.home, 'unrelated-missing'), target);
    } else if (kind === 'scope') {
      await symlink(f.modules, join(target, '@bytedance-dev'));
    } else {
      await mkdir(join(target, sdkName), { recursive: true });
      await writeFile(join(target, sdkName, 'sentinel'), 'preserve me');
    }
    await assert.rejects(ensureRuntimeDependencies(f.home, f.installed, f.runtime), /未覆盖/);
    if (kind === 'package') assert.equal(await readFile(join(target, sdkName, 'sentinel'), 'utf8'), 'preserve me');
  }
});

test('an invalid ESM module reports a dependency failure rather than an account login failure', async t => {
  const f = await fixture(t);
  await writeFile(join(f.sdk, 'index.mjs'), 'export const wrong = true;');
  await assert.rejects(ensureRuntimeDependencies(f.home, f.installed, f.runtime), /无法加载.*依赖.*不是账号未登录/);
});

test('a live daemon missing SDK links is repaired without startup, restart, or fallback login checks', async t => {
  const f = await fixture(t);
  const server = createServer((_req, res) => res.end(JSON.stringify({
    pid: 123456, port: server.address().port, version: supportedRuntime.version, active_requests: 3,
    auth: { source: 'bytecloud', expiresAt: new Date(Date.now() + 3600000).toISOString() },
    catalog: { models: 26 },
  })));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const dataHome = join(f.directory, 'data');
  await atomicJson(join(f.directory, 'prepared.json'), { sourceHash: supportedRuntime.sha256,
    version: supportedRuntime.version, adapterRevision: INSTRUMENTATION_REVISION,
    program: join(f.directory, 'cli.botmux.mjs'), sdkDirectory: f.directory,
    policyHash: digest(await readFile(new URL('../gateway/src/lib/runtime-policy.mjs', import.meta.url), 'utf8')),
    packageRoot: f.installed.packageRoot, dataHome, port: server.address().port });
  await atomicJson(join(dataHome, 'runtime.json'), { pid: 123456, port: server.address().port, token: 'fixture' });
  const result = await ensureManagedRuntime(f.home, {
    detectFerry: async () => f.installed, detectRuntime: async () => f.runtime,
    setupStatus: async () => assert.fail('must not query another daemon for serving auth'),
  });
  assert.equal(result.ready, true);
  assert.equal(result.pid, 123456);
  assert.equal(result.activeRequests, 3);
  assert.equal((await runtimeDependencyStatus(f.home, f.installed)).ready, true);
});

test('serving readiness requires a supported, unexpired auth source and a nonempty catalog', () => {
  const status = { auth: { source: 'bytecloud', expiresAt: new Date(Date.now() + 60000).toISOString() }, catalog: { models: 26 } };
  assert.equal(servingHealth(status).ready, true);
  for (const changed of [
    { ...status, auth: null }, { ...status, auth: { ...status.auth, source: 'unknown' } },
    { ...status, auth: { ...status.auth, expiresAt: new Date(0).toISOString() } },
    { ...status, catalog: { models: 0 } }, { ...status, catalog: {} },
  ]) assert.equal(servingHealth(changed).ready, false);
});
