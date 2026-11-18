import { build } from 'esbuild';
import { mkdir, rm, writeFile, readFile, chmod, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const root = import.meta.dirname;
const dir = join(root, 'gateway');
const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
await rm(join(dir, 'dist'), { recursive: true, force: true });
const entries = {
  'server/settings-implementation.mjs': 'server/settings.mjs',
  'cli/index.js': 'cli/index.mjs',
  'service/runner.mjs': 'service/runner.mjs',
  'service/index.js': 'service/index.mjs',
  'dashboard/index.js': 'dashboard/gateway.mjs',
  'bin/status.mjs': 'bin/status.mjs',
  'bin/client.mjs': 'bin/client.mjs',
  'bin/managed-client.mjs': 'bin/managed-client.mjs',
  'runtime/policy.mjs': 'lib/runtime-policy.mjs',
  'prerequisites/index.mjs': 'bin/prerequisites.mjs',
};
for (const [output, input] of Object.entries(entries)) {
  const browser = output.startsWith('dashboard');
  await build({
    absWorkingDir: root,
    entryPoints: [join(dir, 'src', input)], outfile: join(dir, 'dist', output),
    bundle: true, platform: browser ? 'browser' : 'node', format: 'esm',
    target: 'es2022', minify: browser,
    define: { __FERRY_PLUGIN_VERSION__: JSON.stringify(manifest.version) },
    banner: browser ? undefined : {
      js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
    },
  });
}
// Older hosts may cache an adapter module by its path. Once this stable loader
// is loaded, each call resolves the current implementation by its actual bytes,
// not archive timestamps or a permanently cached import of an older version.
await mkdir(join(dir, 'dist/server'), { recursive: true });
const adapterBytes = await readFile(join(dir, 'dist/server/settings-implementation.mjs'));
const sha256 = createHash('sha256').update(adapterBytes).digest('hex');
const file = `settings-${sha256}.mjs`;
await writeFile(join(dir, 'dist/server', file), adapterBytes);
await writeFile(join(dir, 'dist/server/settings-entry.json'), JSON.stringify({ file, sha256 }));
await cp(join(dir, 'src/server/loader.mjs'), join(dir, 'dist/server/settings.js'));
await chmod(join(dir, 'dist/bin/client.mjs'), 0o755);
await writeFile(join(dir, 'dist/package.json'), '{"type":"module"}\n');
await writeFile(join(dir, 'dist/cli/commands.json'), JSON.stringify({
  schemaVersion: 1, commands: [{ name: 'gateway:status' }],
}));
await cp(join(dir, 'skills'), join(dir, 'dist/skills'), { recursive: true });
await mkdir(join(dir, 'dist/commands'), { recursive: true });
await writeFile(join(dir, 'dist/commands/index.json'), JSON.stringify({
  schemaVersion: 1, endpoint: '/botmux/commands/v1',
  commands: [{ name: '/gateway', description: 'FERRY 状态与同模型加速' }],
}));
console.log('Built FERRY gateway review package. No publication or live installation.');
