import { build } from 'esbuild';
import { mkdir, rm, writeFile, readFile, chmod, cp } from 'node:fs/promises';
import { join } from 'node:path';

const root = import.meta.dirname;
const dir = join(root, 'gateway');
const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
await rm(join(dir, 'dist'), { recursive: true, force: true });
const entries = {
  'server/settings.js': 'server/settings.mjs',
  'cli/index.js': 'cli/index.mjs',
  'service/runner.mjs': 'service/runner.mjs',
  'service/index.js': 'service/index.mjs',
  'dashboard/index.js': 'dashboard/gateway.mjs',
  'bin/status.mjs': 'bin/status.mjs',
  'bin/client.mjs': 'bin/client.mjs',
  'bin/managed-client.mjs': 'bin/managed-client.mjs',
  'runtime/policy.mjs': 'lib/runtime-policy.mjs',
};
for (const [output, input] of Object.entries(entries)) {
  const browser = output.startsWith('dashboard');
  await build({
    entryPoints: [join(dir, 'src', input)], outfile: join(dir, 'dist', output),
    bundle: true, platform: browser ? 'browser' : 'node', format: 'esm',
    target: 'es2022', minify: browser,
    define: { __FERRY_PLUGIN_VERSION__: JSON.stringify(manifest.version) },
    banner: browser ? undefined : {
      js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
    },
  });
}
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
