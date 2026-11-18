import { createHash } from 'node:crypto';
import { open, readFile, realpath, stat } from 'node:fs/promises';
import { join, relative, isAbsolute, sep } from 'node:path';
import { digest, readJson } from '../../../shared/state.mjs';
import { historyFile } from './session-history.mjs';
import { nativeHistoryRoots } from './control-launcher.mjs';
import { sourceRuntime } from './runtime-instrument.mjs';
import { nativeTransitionFile, nativeTargetReceiptFile, transitionChoice } from './native-transition-authority.mjs';
export { nativeTransitionFile, nativeTargetReceiptFile } from './native-transition-authority.mjs';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const sha = b => createHash('sha256').update(b).digest('hex');

// A converted history intentionally has no fabricated successful target turn.
// This private receipt authorizes only its exact, immutable imported prefix.
// It never grants host mutation authority or permits a different native ID.
export async function nativeTransitionHistory(home, appId, sessionId, args, env, topic) {
  if (!uuid.test(sessionId || '') || topic?.bot?.cliId !== 'traex') return null;
  const before = args.slice(0, args.includes('--') ? args.indexOf('--') : args.length);
  const at = before.findIndex(v => ['resume', '--resume'].includes(v));
  if (at < 0) return null;
  const id = before.slice(at + 1).find(v => uuid.test(v));
  if (!id) return null;
  let file = nativeTargetReceiptFile(home, appId, sessionId, id);
  let record = await readJson(file, null);
  if (!record) { file = nativeTransitionFile(home, appId, sessionId); record = await readJson(file, null); }
  if (!record || record.targetId !== id) return null;
  const identity = await stat(file);
  if (!identity.isFile() || (identity.mode & 0o077) !== 0
    || typeof process.getuid === 'function' && identity.uid !== process.getuid()) {
    throw new Error('原生迁移授权文件的所有权或权限不安全');
  }
  if (!transitionChoice(record, topic, appId, sessionId, id)) {
    throw new Error('原生迁移授权与原话题、模型或历史副本不匹配');
  }
  let bytes;
  for (const root of nativeHistoryRoots('traex', env)) {
    const path = await historyFile(id, root);
    if (!path) continue;
    const canonical = await realpath(path), canonicalRoot = await realpath(root);
    const part = relative(canonicalRoot, canonical);
    if (!part || part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part)) throw new Error('原生迁移副本越出当前客户端数据目录');
    const handle = await open(canonical, 'r');
    try {
      const initial = await handle.stat();
      if (!initial.isFile() || initial.size < record.prefixBytes) throw new Error('原生迁移副本已被截断');
      bytes = Buffer.alloc(record.prefixBytes);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) throw new Error('原生迁移副本读取不完整');
        offset += bytesRead;
      }
      if (await realpath(path) !== canonical) throw new Error('原生迁移副本路径已变化');
    } finally { await handle.close(); }
    break;
  }
  if (!bytes || sha(bytes) !== record.prefixSha256) throw new Error('原生迁移副本内容已变化');
  const first = JSON.parse(bytes.subarray(0, bytes.indexOf(10)).toString('utf8'));
  if (first.type !== 'session_meta' || first.payload?.id !== id || first.payload?.model_provider !== record.targetProvider
    || first.payload?.forked_from_id !== record.sourceId) throw new Error('原生迁移副本身份不匹配');
  let transitionRuntime;
  if (record.targetProvider === 'botmux_ferry') {
    const runtime = record.runtime;
    if (!runtime || !sourceRuntime(runtime.sourceHash, runtime.version)
      || !runtime.program?.startsWith(join(home, 'plugins/gateway-acceleration/private/runtime/generations/'))
      || digest(await readFile(runtime.program, 'utf8')) !== runtime.programHash
      || digest(await readFile(join(runtime.program, '../botmux-policy.mjs'), 'utf8')) !== runtime.policyHash) {
      throw new Error('话题切换的目标网关代次无法核验');
    }
    transitionRuntime = runtime;
  }
  return { provider: record.targetProvider, model: record.targetModel, effort: record.effort,
    backendVariant: record.backendVariant, verification: 'authorized-native-copy',
    ...(transitionRuntime ? { transitionRuntime } : {}) };
}
