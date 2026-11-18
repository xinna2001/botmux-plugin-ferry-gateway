import { readFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { digest, readJson } from '../../../shared/state.mjs';
import { sourceRuntime } from './runtime-instrument.mjs';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

// This is NOT a default-setting migration. A local operator must explicitly
// approve a stopped/queued task, capture its exact transcript prefix and topic
// snapshot, and supply a verified new generation. No model/effort/scope changes.
export async function queuedRecovery(home, appId, sessionId, args, now = Date.now()) {
  if (!uuid.test(sessionId || '')) return null;
  const record = await readJson(join(home, 'plugins/gateway-acceleration/private/queued-recovery',
    appId, `${sessionId}.json`), null);
  if (!record) return null;
  if (record.schemaVersion !== 1 || record.appId !== appId || record.sessionId !== sessionId
    || record.authorized !== true || !uuid.test(record.nativeSessionId || '')) throw new Error('排队恢复授权身份无法核验');
  const head = args.slice(0, args.includes('--') ? args.indexOf('--') : args.length);
  const resumeAt = head.findIndex(v => ['resume', '--resume'].includes(v));
  if (resumeAt < 0 || head.slice(resumeAt + 1).find(v => uuid.test(v)) !== record.nativeSessionId) {
    throw new Error('排队恢复必须使用原生会话原 ID');
  }
  const topic = await readJson(join(home, 'plugins/gateway-acceleration/private/topics', appId, `${sessionId}.json`));
  if (digest(topic) !== record.topicHash) throw new Error('排队恢复的原话题配置已变化');
  const expected = topic.binding?.selection;
  if (record.history?.provider !== 'botmux_ferry' || record.history?.model !== expected?.ferryModel
    || record.history?.effort !== topic.bot?.reasoningEffort || topic.scopeEnabled !== true) {
    throw new Error('排队恢复不得改模型、档位或话题范围');
  }
  if (!isAbsolute(record.transcript || '') || !record.transcript.endsWith(`-${record.nativeSessionId}.jsonl`)
    || !Number.isSafeInteger(record.prefixBytes) || record.prefixBytes < 1) throw new Error('排队恢复历史路径无效');
  const bytes = await readFile(record.transcript);
  if (bytes.length < record.prefixBytes || digest(bytes.subarray(0, record.prefixBytes).toString('utf8')) !== record.prefixHash) {
    throw new Error('排队恢复历史发生改写');
  }
  const runtime = record.runtime;
  if (!runtime || !sourceRuntime(runtime.sourceHash, runtime.version)
    || !runtime.program?.startsWith(join(home, 'plugins/gateway-acceleration/private/runtime/generations/'))
    || digest(await readFile(runtime.program, 'utf8')) !== runtime.programHash
    || digest(await readFile(join(runtime.program, '../botmux-policy.mjs'), 'utf8')) !== runtime.policyHash) {
    throw new Error('排队恢复目标网关无法核验');
  }
  let unfinishedAllowed = record.expiresAt > now;
  for (const line of bytes.subarray(record.prefixBytes).toString('utf8').split('\n').filter(Boolean)) {
    let row;
    try { row = JSON.parse(line); } catch { unfinishedAllowed = false; break; }
    const value = row.payload || {};
    if (row.type === 'turn_context' || row.type === 'response_item' && value.role === 'assistant'
      || row.type === 'event_msg' && ['task_complete', 'turn_complete'].includes(value.type)) unfinishedAllowed = false;
  }
  return { runtime, history: record.history, unfinishedAllowed };
}
