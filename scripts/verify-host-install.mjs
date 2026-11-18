import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const home = await mkdtemp(join(tmpdir(), 'ferry-host-install-'));
const configHome = join(home, '.botmux');
const pluginHome = join(configHome, 'plugins/gateway-acceleration');
const executable = process.env.BOTMUX_TEST_EXECUTABLE || 'botmux';
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  !name.startsWith('BOTMUX') && !name.startsWith('FERRY_') && !name.startsWith('PM2')
  && !['BOTS_CONFIG', 'SESSION_DATA_DIR', 'PLUGIN_PM2_HOME', 'BUN_BE_BUN', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME'].includes(name)));
Object.assign(env, {
  HOME: home, USERPROFILE: home, BOTS_CONFIG: join(configHome, 'bots.json'),
  SESSION_DATA_DIR: join(configHome, 'data'), BOTMUX_NO_CLAIM: '1',
});

try {
  await mkdir(join(pluginHome, 'private'), { recursive: true });
  const protectedFiles = new Map([
    [join(configHome, 'bots.json'), JSON.stringify([{ larkAppId: 'cli_install_fixture', cliId: 'codex',
      model: 'fixture-model', plugins: ['gateway-acceleration'] }])],
    [join(configHome, 'config.json'), '{"plugins":[]}'],
    [join(pluginHome, 'config.json'), '{"preserve":"existing route"}'],
    [join(pluginHome, 'settings.json'), '{"schemaVersion":1,"defaults":{"preserve":true},"bots":{}}'],
    [join(pluginHome, 'private/fixture.txt'), 'private-fixture-preserved'],
  ]);
  for (const [file, content] of protectedFiles) await writeFile(file, content, { mode: 0o600 });
  const packed = await exec('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', home],
    { cwd: join(root, 'gateway'), timeout: 30000 });
  const archive = join(home, JSON.parse(packed.stdout)[0].filename);
  const manifest = JSON.parse(await readFile(join(root, 'gateway/package.json'), 'utf8'));
  const registryFile = join(configHome, 'plugins-registry.json');
  for (const pass of ['install', 'metadata-repair']) {
    await exec(executable, ['plugin', 'install', `file:${archive}`], { cwd: home, env, timeout: 60000 });
    const registry = JSON.parse(await readFile(registryFile, 'utf8'));
    const record = registry.plugins['gateway-acceleration'];
    assert.equal(record.version, manifest.version);
    assert.equal(record.description, manifest.description);
    assert.equal(record.manifest.audience, '仅限字节内部使用');
    assert.equal((await lstat(join(pluginHome, 'dist'))).isSymbolicLink(), false);
    for (const [file, content] of protectedFiles) assert.equal(await readFile(file, 'utf8'), content);
    if (pass === 'install') {
      delete record.description;
      delete record.manifest.audience;
      await writeFile(registryFile, JSON.stringify(registry), { mode: 0o600 });
    }
  }
  const version = await exec(executable, ['--version'], { cwd: home, env, timeout: 10000 });
  console.log(JSON.stringify({ passed: true, hostVersion: version.stdout.trim(), pluginVersion: manifest.version,
    metadataRepaired: true, modelScopeConfigAndPrivateFilesPreserved: true, isolatedHome: true }));
} finally {
  await rm(home, { recursive: true, force: true });
}
