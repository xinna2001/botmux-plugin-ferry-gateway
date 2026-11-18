import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJson, digest, readJson, withLock, enabledFor } from '../../../shared/state.mjs';
import { managementAuthority, assertManagementAuthority } from './host-control.mjs';
import { nativeHistoryRoots, resolveHistoryConfiguration } from './control-launcher.mjs';
import { historyFile } from './session-history.mjs';
import { queuedRecovery } from './queued-recovery.mjs';
import { managedRuntimeStatus } from './managed-runtime.mjs';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export async function reconcileSameIdRuntime(home, topic, intent, deps) {
  const request = deps.request, now = deps.now?.() ?? Date.now();
  const result = (phase, message = '') => ({ phase, message, revision: intent.revision });
  if (intent.mode !== 'gateway') return result('blocked', '此 Codex 旧话题尚不能自动退出到原生线路；加速关闭单独生效，不更换模型');
  if (topic.scopeEnabled !== true || topic.binding?.forwarding !== true) return result('blocked', '原话题没有网关转发授权，不自动更换 provider');
  const base = join(home, 'plugins/gateway-acceleration/private');
  const file = join(base, 'runtime-operations', topic.appId, `${topic.sessionId}.json`);
  const configFile = join(home, 'plugins/gateway-acceleration/config.json');
  const currentIntent = async () => {
    await assertManagementAuthority(home, intent.authority);
    if (!await enabledFor('gateway-acceleration', topic.appId, home)) return false;
    const config = await readJson(configFile);
    return digest(config.routingIntents?.bots?.[topic.appId] ?? null) === digest(intent);
  };
  if (!uuid.test(topic.sessionId || '') || await managementAuthority(home) !== intent.authority) return result('blocked', '管理授权已变化');
  return withLock(file, async () => {
    const state = await request(`/api/sessions/${topic.sessionId}/resume-target`);
    if (state.protocol !== 1 || state.sameIdRuntimeRestartSupported !== true
      || !uuid.test(state.nativeSessionId || '')) return result('blocked', '宿主尚未提供此会话的安全同 ID 更新能力');
    const id = state.nativeSessionId, args = ['resume', id];
    let operation = await readJson(file, null);
    if (operation?.revision === intent.revision && operation.nativeSessionId !== id) return result('blocked', '原生身份已变化，未继续重启');
    if (operation?.revision === intent.revision && operation.state === 'verified') return result('verified');
    if (state.retiring) return result('waiting', '等待原进程退出，不重复启动');
    const env = deps.env || process.env;
    if (!operation || operation.revision !== intent.revision) {
      if (!state.cold && (!state.workerReady || !state.cliReady || state.busy)) {
        return result('waiting', '等待当前回答、工具和投递结束，再保留原 ID 更新网关');
      }
      const history = await resolveHistoryConfiguration('codex', args, env);
      if (history?.provider !== 'botmux_ferry' || history.model !== topic.binding.selection?.ferryModel
        || history.effort !== topic.bot.reasoningEffort) return result('blocked', '无法证明原 provider、模型和档位一致');
      const runtime = await readJson(join(base, 'runtime/prepared.json'), null);
      if (!(await (deps.runtimeStatus || managedRuntimeStatus)(home, { prepared: runtime })).ready) {
        return result('blocked', '目标网关未就绪，保留原运行代次');
      }
      const recovery = await queuedRecovery(home, topic.appId, topic.sessionId, args);
      const prior = recovery?.runtime || topic.runtime;
      const launch = await readJson(join(base, 'runtime-launches', topic.appId, `${topic.sessionId}.json`), null);
      if (prior?.policyHash === runtime.policyHash && prior?.programHash === runtime.programHash
        && (topic.runtime?.programHash === runtime.programHash || launch?.nativeSessionId === id
          && launch.programHash === runtime.programHash)) return result('verified');
      let transcript;
      for (const root of nativeHistoryRoots('codex', env)) {
        transcript = await historyFile(id, root);
        if (transcript) break;
      }
      if (!transcript) return result('blocked', '原始历史不可核验');
      const bytes = await readFile(transcript);
      if (!bytes.length || bytes.length > 64 * 1024 * 1024 || !Buffer.from(bytes.toString('utf8')).equals(bytes)) {
        return result('blocked', '原始历史大小或编码不可核验');
      }
      if (!await currentIntent()) return result('superseded');
      await atomicJson(join(base, 'queued-recovery', topic.appId, `${topic.sessionId}.json`), {
        schemaVersion: 1, authorized: true, appId: topic.appId, sessionId: topic.sessionId,
        nativeSessionId: id, topicHash: digest(topic), transcript, prefixBytes: bytes.length,
        prefixHash: digest(bytes.toString('utf8')), expiresAt: 0, history, runtime,
      });
      // Same verification as the actual launcher, BEFORE stopping anything.
      await queuedRecovery(home, topic.appId, topic.sessionId, args);
      operation = { revision: intent.revision, nativeSessionId: id, runtime, history, state: 'prepared',
        createdAt: now, parkAttempts: 0, wakeAttempts: 0 };
      await atomicJson(file, operation);
    }
    if (!await currentIntent()) return result('superseded');
    const launch = await readJson(join(base, 'runtime-launches', topic.appId, `${topic.sessionId}.json`), null);
    if (state.workerReady && state.cliReady && !state.busy && launch?.nativeSessionId === id
      && launch.programHash === operation.runtime.programHash && launch.policyHash === operation.runtime.policyHash
      && launch.startedAt >= operation.createdAt && launch.port === operation.runtime.port) {
      await atomicJson(file, { ...operation, state: 'verified', verifiedAt: now });
      return result('verified');
    }
    const action = state.cold ? 'prepare' : 'park';
    if (!state.cold && (!state.workerReady || !state.cliReady || state.busy)) {
      return result('waiting', '等待当前回答、工具和投递结束，再保留原 ID 更新网关');
    }
    const latest = await resolveHistoryConfiguration('codex', args, env);
    if (['provider', 'model', 'effort'].some(k => latest?.[k] !== operation.history?.[k])) {
      return result('blocked', '历史模型或档位已变化，未按旧授权重启');
    }
    const key = state.cold ? 'wakeAttempts' : 'parkAttempts';
    if (operation[key] >= 3) return result('blocked', '安全更新未确认，请检查宿主状态后重试开关');
    if (operation.lastActionAt && now - operation.lastActionAt < 15000) return result('switching', '正在保留原生 ID 更新网关');
    operation = { ...operation, [key]: operation[key] + 1, lastActionAt: now, state: action };
    await atomicJson(file, operation);
    await request(`/api/sessions/${topic.sessionId}/resume-target/${action}`, 'POST', { sourceId: id });
    return result('switching', '正在保留原生 ID 更新网关，不注入新任务');
  });
}
