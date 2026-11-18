import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, readJson } from '../../../shared/state.mjs';

const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

export async function prepareLegacyBridge(binding, appId, home) {
  const legacy = binding.native?.legacy;
  if (!legacy || legacy.alias) return null;
  const bots = await readJson(join(home, 'bots.json'), []);
  if (bots.some(bot => bot.larkAppId !== appId
    && [bot.cliPathOverride, bot.cliRuntime?.executable].includes(legacy.path))) {
    throw new Error('当前启动器由多个 Bot 共用，不能单独接管');
  }
  const original = await readFile(legacy.path);
  const originalHash = digest(original.toString('utf8'));
  if (legacy.hashes[legacy.path] !== originalHash) throw new Error('旧启动器已变化，未接管');
  const source = `#!/bin/sh\nexec ${quote(binding.launcher)} "$@"\n`;
  const backup = join(dirname(binding.launcher), `legacy-entry-${originalHash}.backup`);
  try { await writeFile(backup, original, { mode: 0o700, flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST' || !(await readFile(backup)).equals(original)) throw error;
  }
  const metadata = { path: legacy.path, sha256: digest(source), originalHash, backup };
  legacy.alias = metadata;
  legacy.hashes = { ...legacy.hashes, [legacy.path]: metadata.sha256 };
  return { metadata, source, original };
}

async function replace(path, bytes) {
  const staged = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(staged, bytes, { mode: 0o700, flag: 'wx' });
    await rename(staged, path);
  } finally { await rm(staged, { force: true }); }
}

export async function applyLegacyBridge(bridge) {
  if (!bridge) return;
  if (digest((await readFile(bridge.metadata.path)).toString('utf8')) !== bridge.metadata.originalHash) {
    throw new Error('旧启动器被并发修改，未覆盖');
  }
  await replace(bridge.metadata.path, bridge.source);
}

export async function restoreLegacyBridge(bridge) {
  if (!bridge) return;
  const current = digest((await readFile(bridge.metadata.path)).toString('utf8'));
  if (current === bridge.metadata.originalHash) return;
  if (current !== bridge.metadata.sha256) throw new Error('启动器已被其他操作修改，无法安全回滚');
  await replace(bridge.metadata.path, bridge.original);
}
