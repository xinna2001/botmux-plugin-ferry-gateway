import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const exec = promisify(execFile);
const root = join(import.meta.dirname, '..');
const home = await mkdtemp(join(tmpdir(), 'ferry-package-review-'));
try {
  const { stdout } = await exec('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', home],
    { cwd: join(root, 'gateway'), timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  const packed = JSON.parse(stdout)[0];
  assert.ok(packed.files.length > 0);
  for (const file of packed.files) {
    assert.ok(file.path === 'package.json' || file.path === 'README.md' || file.path.startsWith('dist/'));
    assert.doesNotMatch(file.path, /node_modules|\.env|config\.json|runtime\.json|\.log$|\.pem$/);
  }
  const stage = join(home, 'unpacked');
  await mkdir(stage);
  await exec('tar', ['-xzf', join(home, packed.filename), '-C', stage]);
  const base = join(stage, 'package');
  const pkg = JSON.parse(await readFile(join(base, 'package.json'), 'utf8'));
  assert.equal(pkg.private, true);
  assert.equal(pkg.botmux.id, 'gateway-acceleration');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BOTMUX_') && !key.startsWith('FERRY_')));
  Object.assign(env, { HOME: home, USERPROFILE: home, BOTMUX_PLUGIN_TEST_HOME: join(home, '.botmux'), npm_config_prefix: join(home, 'npm-global') });
  const module = pathToFileURL(join(base, 'dist/server/settings.js')).href;
  const value = await exec(process.execPath, ['--input-type=module', '-e',
    `const m=await import(${JSON.stringify(module)});console.log(JSON.stringify(await m.getSettings()));`],
  { env, cwd: home, timeout: 30000 });
  const settings = JSON.parse(value.stdout);
  assert.deepEqual(settings.profiles, []);
  assert.equal(settings.setup.installed, false);
  for (const file of packed.files.filter(file => file.path.endsWith('.js') || file.path.endsWith('.mjs'))) {
    const text = await readFile(join(base, file.path), 'utf8');
    assert.doesNotMatch(text, /\/(?:Users|home)\/[a-zA-Z0-9_.-]+\//);
    assert.doesNotMatch(text, /ou_[a-f0-9]{32}|cli_[a-f0-9]{16}|PRIVATE KEY/);
  }
  console.log(JSON.stringify({ passed: true, tarballFiles: packed.files.length, isolatedHome: true, published: false }));
} finally { await rm(home, { recursive: true, force: true }); }
