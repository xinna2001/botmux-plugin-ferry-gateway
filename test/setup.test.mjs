import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { atomicJson, readJson, pluginConfig } from '../shared/state.mjs';
import { prepareInstall, installFerry, setupStatus, connectFerry, connectionConfig } from '../gateway/src/lib/setup.mjs';

const ID = 'gateway-acceleration';
const archiveBytes = Buffer.from('fixture-package');
const integrity = 'sha512-' + createHash('sha512').update(archiveBytes).digest('base64');
const pkg = { name: '@ad/ferry', version: '0.1.98' };
async function fixture(t, hooks = {}) {
  const home = await mkdtemp(join(tmpdir(), 'ferry-setup-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await atomicJson(pluginConfig(ID, home), {});
  await writeFile(join(home, '.dashboard-token'), 'initial-token');
  const calls = [];
  let online = !hooks.offline;
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    if (command === 'npm' && args[0] === 'root') return { stdout: join(home, 'global') };
    if (command === 'node' && args[0] === '--version') return { stdout: 'v24.0.0' };
    if (command === 'npm' && args[0] === 'view') return { stdout: JSON.stringify({ version: pkg.version, 'dist.integrity': integrity }) };
    if (command === 'npm' && args[0] === 'pack') {
      const destination = args[args.indexOf('--pack-destination') + 1];
      await writeFile(join(destination, 'ferry.tgz'), hooks.corrupt ? Buffer.from('corrupt') : archiveBytes);
      return { stdout: JSON.stringify([{ filename: 'ferry.tgz' }]) };
    }
    if (command === 'tar') return { stdout: JSON.stringify(pkg) };
    if (command === 'npm' && args[0] === 'install') {
      const prefix = args[args.indexOf('--prefix') + 1];
      await atomicJson(join(prefix, 'node_modules/@ad/ferry/package.json'), pkg);
      await mkdir(join(prefix, 'node_modules/@ad/ferry/dist'));
      await writeFile(join(prefix, 'node_modules/@ad/ferry/dist/cli.js'), '// fixture');
      await hooks.install?.(home);
      return { stdout: '' };
    }
    if (command === 'node' && args.includes('status')) return { stdout: JSON.stringify({
      version: pkg.version, bytecloud: { authenticated: true }, daemon: { state: online ? 'running' : 'stopped', runtime: { port: 18790 }, status: { active_requests: 0 } },
    }) };
    if (command === 'node' && ['start', 'login', 'stop'].some(value => args.includes(value))) { if (args.includes('start')) online = true; if (args.includes('stop')) online = false; return { stdout: '' }; }
    if (command === 'node' && args.includes('config')) return { stdout: 'model_provider = "ferry"\n' };
    throw new Error(`Unexpected command ${command} ${args[0]}`);
  };
  return { home, calls, deps: { run } };
}
test('install requires a live confirmation and does not run lifecycle scripts', async t => {
  const { home, calls, deps } = await fixture(t);
  const plan = await prepareInstall(home, deps);
  await assert.rejects(installFerry({ nonce: plan.nonce, confirm: false }, home, deps), /确认已失效/);
  assert.equal(calls.filter(call => call.args[0] === 'pack').length, 0);
  const result = await installFerry({ nonce: plan.nonce, confirm: true }, home, deps);
  assert.equal(result.installed, true);
  const install = calls.find(call => call.args[0] === 'install');
  assert.ok(install.args.includes('--ignore-scripts'));
  assert.ok(install.args.includes('--registry=https://bnpm.byted.org'));
  assert.ok(!install.args.includes('-g'));
  assert.ok(!calls.some(call => ['start', 'login', 'restart'].some(arg => call.args.includes(arg))));
  await assert.rejects(installFerry({ nonce: plan.nonce, confirm: true }, home, deps), /确认已失效/);
});
test('install rejects a modified archive before npm installation', async t => {
  const { home, calls, deps } = await fixture(t, { corrupt: true });
  const plan = await prepareInstall(home, deps);
  await assert.rejects(installFerry({ nonce: plan.nonce, confirm: true }, home, deps), /完整性/);
  assert.ok(!calls.some(call => call.args[0] === 'install'));
  assert.equal((await setupStatus(home, deps)).installed, false);
});
test('rotated management authority invalidates the install plan', async t => {
  const { home, deps } = await fixture(t);
  const plan = await prepareInstall(home, deps);
  await writeFile(join(home, '.dashboard-token'), 'rotated');
  await assert.rejects(installFerry({ nonce: plan.nonce, confirm: true }, home, deps), /确认已失效/);
});
test('authority rotation during npm install cannot commit a dependency', async t => {
  const { home, deps } = await fixture(t, { install: home => writeFile(join(home, '.dashboard-token'), 'rotated') });
  const plan = await prepareInstall(home, deps);
  await assert.rejects(installFerry({ nonce: plan.nonce, confirm: true }, home, deps), /环境已变化/);
  assert.equal((await setupStatus(home, deps)).installed, false);
  await assert.rejects(access(join(home, 'local', 'ferry-plugin-dependency', pkg.version)));
});
test('an unverified global installation is not overwritten while a compatible private copy is prepared', async t => {
  const { home, calls, deps } = await fixture(t, { offline: true });
  await atomicJson(join(home, 'global/@ad/ferry/package.json'), pkg);
  await mkdir(join(home, 'global/@ad/ferry/dist'));
  await writeFile(join(home, 'global/@ad/ferry/dist/cli.js'), '// existing');
  const plan = await prepareInstall(home, deps);
  assert.equal(plan.version, '0.1.98');
  await assert.rejects(connectFerry({ action: 'connect', confirm: true }, home, deps), /原有进程管理/);
  assert.ok(!calls.some(call => call.args.includes('start') || call.args.includes('restart') || call.args[0] === 'install'));
  assert.equal(await readFile(join(home, 'global/@ad/ferry/dist/cli.js'), 'utf8'), '// existing');
});
test('new gateway connection uses Node, needs confirmation and leaves client config alone', async t => {
  const { home, calls, deps } = await fixture(t, { offline: true });
  const plan = await prepareInstall(home, deps);
  await installFerry({ nonce: plan.nonce, confirm: true }, home, deps);
  await assert.rejects(connectFerry({ action: 'connect' }, home, deps), /明确确认/);
  await connectFerry({ action: 'connect', confirm: true }, home, deps);
  const start = calls.find(call => call.args.includes('start'));
  assert.equal(start.command, 'node');
  assert.ok(start.args.includes('18790'));
  assert.ok(start.options.env.FERRY_HOME.startsWith(home));
  assert.deepEqual(await readJson(pluginConfig(ID, home)), {});
  assert.equal((await connectionConfig(home, deps)).applied, false);
  await connectFerry({ action: 'disconnect', confirm: true }, home, deps);
  await assert.rejects(connectionConfig(home, deps), /先连接网关/);
});
test('concurrent replay consumes one installation confirmation only once', async t => {
  const { home, calls, deps } = await fixture(t);
  const plan = await prepareInstall(home, deps);
  const input = { nonce: plan.nonce, confirm: true };
  const results = await Promise.allSettled([installFerry(input, home, deps), installFerry(input, home, deps)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(calls.filter(call => call.args[0] === 'install').length, 1);
});
test('expired confirmation cannot download or install', async t => {
  const { home, calls, deps } = await fixture(t);
  const plan = await prepareInstall(home, deps);
  t.mock.method(Date, 'now', () => plan.expiresAt + 1);
  await assert.rejects(installFerry({ nonce: plan.nonce, confirm: true }, home, deps), /确认已失效/);
  assert.ok(!calls.some(call => call.args[0] === 'pack'));
});
test('missing authority fails closed rather than accepting an empty identity', async t => {
  const { home, calls, deps } = await fixture(t);
  const plan = await prepareInstall(home, deps);
  await rm(join(home, '.dashboard-token'));
  await assert.rejects(installFerry({ nonce: plan.nonce, confirm: true }, home, deps));
  assert.ok(!calls.some(call => call.args[0] === 'install'));
});
