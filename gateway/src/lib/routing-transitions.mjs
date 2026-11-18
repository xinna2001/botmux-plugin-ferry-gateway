import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { atomicJson, digest, readJson, withLock, validateAppId, enabledFor } from '../../../shared/state.mjs';
import { hostRequest, managementAuthority, assertManagementAuthority } from './host-control.mjs';
import { readTopic } from './topic-state.mjs';
import { historyFile, expectedPendingFromTopic } from './session-history.mjs';
import { nativeHistoryRoots, resolveHistoryConfiguration } from './control-launcher.mjs';
import { createNativeHistory } from './native-history-copy.mjs';
import { nativeTargetReceiptFile, nativeTransitionHistory } from './native-transition-receipt.mjs';
import { managedRuntimeStatus } from './managed-runtime.mjs';
import { reconcileSameIdRuntime } from './same-id-runtime.mjs';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const base = home => join(home, 'plugins/gateway-acceleration/private');
const statusFile = home => join(base(home), 'routing-status.json');
const cursors = new Map();
const redacted = {
  unsupported_cli: '此客户端的旧话题暂不能自动换线路；不会偷偷更换模型',
  host_unavailable: '宿主迁移接口未就绪，保留原历史，等待宿主升级或恢复',
  authority_changed: '管理授权已变化，请重新确认开关',
  history_unverified: '无法核验完整历史、模型或档位，保留原线路',
  waiting_idle: '等待当前回答和工具执行结束，再安全切换',
  warming: '正在唤醒休眠话题以安全切换，不发送新任务',
  prepare_failed: '旧话题唤醒未成功，保留原线路，等待有界重试',
  retiring: '等待旧进程完成退出，不重复启动',
  switching: '正在保留历史并切换线路',
  retry_required: '切换未确认，原历史保留；请重试开关并检查宿主状态',
};

// Called only from the existing authenticated, serialized settings transaction.
// It is explicit authorization for a new routing operation, never a rewrite of
// the immutable per-topic provider/model snapshot.
export function setRoutingIntent(config, appId, mode, authority, now = Date.now()) {
  validateAppId(appId);
  if (!['native', 'gateway'].includes(mode) || !/^[a-f0-9]{64}$/.test(authority || '')) throw new Error('Invalid routing authorization');
  const revision = (config.routingIntents?.revision || 0) + 1;
  config.routingIntents = { schemaVersion: 1, revision,
    bots: { ...config.routingIntents?.bots, [appId]: { mode, revision, authority, changedAt: now } } };
}

export async function routingStatus(home) {
  return readJson(statusFile(home), { bots: {} });
}

export function routingProjection(config, observed, appId) {
  const intent = config.routingIntents?.bots?.[appId];
  if (!intent) return null;
  const status = observed?.bots?.[appId];
  const { topics, ...projection } = status || {};
  return status?.revision === intent.revision ? projection
    : { revision: intent.revision, mode: intent.mode, phase: 'pending',
      message: '开关已保存，正在核对旧话题的实际线路' };
}

function operationFile(home, appId, sessionId) {
  validateAppId(appId);
  if (!uuid.test(sessionId)) throw new Error('invalid_topic');
  return join(base(home), 'routing-operations', appId, `${sessionId}.json`);
}

async function safeHistory(home, topic, nativeId, env) {
  const args = ['resume', nativeId];
  const receipt = await nativeTransitionHistory(home, topic.appId, topic.sessionId, args, env, topic);
  let history;
  try {
    const request = await readJson(join(base(home), 'requests', topic.appId, `${topic.sessionId}.json`), null);
    // The host has independently proved idle before this call. A completed
    // zero-output primary request may describe an aborted/rejected first turn;
    // keep its exact identity/model/effort proof, without inventing success.
    const observed = request?.primary === true && request.generated === false
      && ['complete', 'aborted'].includes(request.phase) ? { ...request, phase: 'error' } : request;
    history = await resolveHistoryConfiguration('traex', args, env,
      { expectedPending: expectedPendingFromTopic(topic, observed) });
  } catch (error) {
    if (error.code !== 'NO_VERIFIED_HISTORY_CONFIGURATION' || !receipt) throw error;
    history = receipt;
  }
  return { history, receipt };
}

export async function reconcileTopicRouting(home, topic, intent, deps = {}) {
  const request = deps.request || ((path, method, body) => hostRequest(home, path, method, body));
  const now = deps.now?.() ?? Date.now();
  const result = (phase, code = phase) => ({ phase, message: redacted[code] || '', revision: intent.revision });
  if (!['native', 'gateway'].includes(intent.mode) || !Number.isSafeInteger(intent.revision) || intent.revision < 1) {
    return result('blocked', 'history_unverified');
  }
  if (!await enabledFor('gateway-acceleration', topic.appId, home)) return result('blocked', 'authority_changed');
  if (topic.bot?.cliId === 'codex') return reconcileSameIdRuntime(home, topic, intent, { ...deps, request });
  if (topic.bot?.cliId !== 'traex') return result('blocked', 'unsupported_cli');
  if (await managementAuthority(home) !== intent.authority) return result('blocked', 'authority_changed');
  const file = operationFile(home, topic.appId, topic.sessionId);
  return withLock(file, async () => {
    let state;
    try { state = await request(`/api/sessions/${topic.sessionId}/resume-target`); }
    catch { return result('blocked', 'host_unavailable'); }
    if (state.protocol !== 1 || !uuid.test(state.nativeSessionId || '')) return result('blocked', 'host_unavailable');
    if (state.retiring) return result('waiting', 'retiring');
    let operation = await readJson(file, null);
    if (operation?.revision === intent.revision && operation.state === 'verified'
      && state.nativeSessionId === operation.targetId) return result('verified');
    let copyAttempts = operation?.revision === intent.revision ? operation.copyAttempts || 0 : 0;
    if (state.cold === true) {
      const warm = operation?.kind === 'warming' && operation.revision === intent.revision ? operation : null;
      if (warm?.wakeAttempts >= 3) return result('blocked', 'retry_required');
      if (warm && now - warm.wakeAt < 15000) return result('waiting',
        state.preparation?.state === 'failed' ? 'prepare_failed' : 'warming');
      const current = await readJson(join(home, 'plugins/gateway-acceleration/config.json'));
      if (digest(current.routingIntents?.bots?.[topic.appId] ?? null) !== digest(intent)) return result('superseded');
      if (!await enabledFor('gateway-acceleration', topic.appId, home)) return result('superseded');
      await assertManagementAuthority(home, intent.authority);
      await atomicJson(file, { kind: 'warming', revision: intent.revision, sourceId: state.nativeSessionId,
        wakeAt: now, wakeAttempts: (warm?.wakeAttempts || 0) + 1 });
      try {
        await request(`/api/sessions/${topic.sessionId}/resume-target/prepare`, 'POST', { sourceId: state.nativeSessionId });
      } catch { return result('blocked', 'host_unavailable'); }
      return result('waiting', 'warming');
    }
    if (operation?.kind === 'warming') operation = null;
    if (operation && state.nativeSessionId === operation.targetId) {
      if (!state.workerReady || !state.cliReady || state.busy) return result('waiting', 'waiting_idle');
      operation = { ...operation, state: 'verified', verifiedAt: now };
      await atomicJson(file, operation);
      const receiptFile = nativeTargetReceiptFile(home, topic.appId, topic.sessionId, operation.targetId);
      const receipt = await readJson(receiptFile, null);
      if (receipt) await atomicJson(receiptFile, { ...receipt, state: 'verified' });
      // A newer opposing switch must converge from the ACTUAL target, never
      // jump back to an older original and lose work done after the transition.
      if (operation.revision === intent.revision) return result('verified');
    }
    if (!state.workerReady || !state.cliReady || state.busy) return result('waiting', 'waiting_idle');
    if (operation?.revision === intent.revision && state.nativeSessionId === operation.sourceId
      && state.transition?.state === 'failed'
      && state.transition?.targetId === operation.targetId
      && ['native_resume_history_changed', 'native_resume_source_changed'].includes(state.transition.errorCode)) {
      // A real source can finish a late persistence flush after an idle screen.
      // Never retry a stale byte hash forever or discard that newly saved work.
      if (copyAttempts >= 3) return result('blocked', 'retry_required');
      operation = null;
    }
    if (operation?.revision === intent.revision && operation.state !== 'verified') {
      if (state.nativeSessionId !== operation.sourceId) return result('blocked', 'history_unverified');
      if (operation.attempts >= 3) return result('blocked', 'retry_required');
      const cooldown = [5000, 15000, 30000][Math.max(0, operation.attempts - 1)];
      if (operation.postedAt && now - operation.postedAt < cooldown) return result('switching');
      // Reconcile before resending the SAME exact source/target pair. The host
      // serializes lifecycle changes and refuses an already-replaced source.
      // Never create another copy merely because an HTTP response was lost.
    } else {
      let history, previousReceipt, sourcePath, root;
      try {
        const env = deps.env || process.env;
        ({ history, receipt: previousReceipt } = await safeHistory(home, topic, state.nativeSessionId, env));
        const choices = (topic.binding?.modelChoices || [topic.binding?.selection]).filter(Boolean);
        const choice = choices.find(c => history.provider === 'trae'
          ? c.clientModel === history.model && c.backendVariant === history.backendVariant
          : c.ferryModel === history.model);
        if (!choice || !choice.efforts?.includes(history.effort)) return result('blocked', 'history_unverified');
        const targetProvider = intent.mode === 'native' ? 'trae' : 'botmux_ferry';
        const runtime = targetProvider === 'botmux_ferry'
          ? await readJson(join(base(home), 'runtime/prepared.json'), null) : undefined;
        if (targetProvider === 'botmux_ferry' && !(await (deps.runtimeStatus || managedRuntimeStatus)(home, { prepared: runtime })).ready) {
          return result('blocked', 'host_unavailable');
        }
        const currentRuntime = previousReceipt?.transitionRuntime || topic.runtime;
        const hasGatewayGrant = previousReceipt?.provider === 'botmux_ferry'
          || topic.scopeEnabled === true && topic.binding?.acceleration === true;
        if (history.provider === targetProvider && (targetProvider === 'trae'
          || hasGatewayGrant && runtime?.policyHash && runtime.policyHash === currentRuntime?.policyHash
          && runtime.adapterRevision === currentRuntime.adapterRevision)) return result('verified');
        for (const candidate of nativeHistoryRoots('traex', env)) {
          const found = await historyFile(state.nativeSessionId, candidate);
          if (found) { sourcePath = found; root = candidate; break; }
        }
        if (!sourcePath) return result('blocked', 'history_unverified');
        await assertManagementAuthority(home, intent.authority);
        const config = await readJson(join(home, 'plugins/gateway-acceleration/config.json'));
        if (digest(config.routingIntents?.bots?.[topic.appId] ?? null) !== digest(intent)) return result('superseded');
        if (!await enabledFor('gateway-acceleration', topic.appId, home)) return result('superseded');
        const copied = (deps.copy || createNativeHistory)(sourcePath, dirname(root), {
          sourceId: state.nativeSessionId, sourceProvider: history.provider, targetProvider,
          model: targetProvider === 'trae' ? choice.clientModel : choice.ferryModel,
          effort: history.effort, backendVariant: choice.backendVariant,
        });
        const receipt = { schemaVersion: 1, authorized: true, state: 'prepared',
          appId: topic.appId, sessionId: topic.sessionId, sourceId: state.nativeSessionId,
          targetId: copied.targetId, topicHash: digest(topic), sourceModel: history.model,
          targetProvider, targetModel: copied.targetModel, effort: history.effort,
          backendVariant: choice.backendVariant, prefixBytes: copied.targetBytes,
          prefixSha256: copied.targetSha256, ...(runtime ? { runtime } : {}) };
        await atomicJson(nativeTargetReceiptFile(home, topic.appId, topic.sessionId, copied.targetId), receipt);
        // Validate precisely what the launcher will read BEFORE requesting any
        // retirement. Invalid runtime bytes or receipt ownership cannot strand
        // a task after its original process has been stopped.
        await nativeTransitionHistory(home, topic.appId, topic.sessionId, ['resume', copied.targetId], env, topic);
        operation = { schemaVersion: 1, revision: intent.revision, mode: intent.mode, state: 'prepared',
          sourceId: state.nativeSessionId, targetId: copied.targetId,
          sourceSha256: copied.sourceSha256, targetSha256: copied.targetSha256, attempts: 0,
          copyAttempts: copyAttempts + 1, createdAt: now };
        await atomicJson(file, operation);
      } catch { return result('blocked', 'history_unverified'); }
    }
    try {
      await assertManagementAuthority(home, intent.authority);
      const current = await readJson(join(home, 'plugins/gateway-acceleration/config.json'));
      if (digest(current.routingIntents?.bots?.[topic.appId] ?? null) !== digest(intent)) return result('superseded');
      if (!await enabledFor('gateway-acceleration', topic.appId, home)) return result('superseded');
      operation = { ...operation, state: 'submitting', attempts: operation.attempts + 1, postedAt: now };
      await atomicJson(file, operation);
      const response = await request(`/api/sessions/${topic.sessionId}/resume-target`, 'POST',
        Object.fromEntries(['sourceId', 'targetId', 'sourceSha256', 'targetSha256'].map(k => [k, operation[k]])));
      if (response.state !== 'accepted' || !response.attemptId) throw new Error('unconfirmed');
      await atomicJson(file, { ...operation, state: 'accepted', attemptId: response.attemptId });
      return result('switching');
    } catch {
      await atomicJson(file, { ...operation, state: 'unconfirmed' });
      return result('switching');
    }
  });
}

// Service-owned, bounded reconciliation. No model probes, no prompt injection,
// no rewriting topic snapshots, and no revival of explicitly closed topics.
export async function reconcileRoutingTransitions(home, deps = {}) {
  const config = await readJson(join(home, 'plugins/gateway-acceleration/config.json'));
  const intents = Object.entries(config.routingIntents?.bots || {});
  if (!intents.length) return;
  const authority = await managementAuthority(home);
  const prior = await routingStatus(home), next = { observedAt: Date.now(), bots: { ...prior.bots } };
  let listing;
  try { listing = await (deps.list || (() => hostRequest(home, '/api/sessions')))(); }
  catch { return; }
  const rows = new Map((listing.sessions || []).map(row => [row.sessionId, row]));
  for (const [appId, intent] of intents) {
    const summary = { revision: intent.revision, mode: intent.mode, phase: 'verified',
      counts: { verified: 0, waiting: 0, switching: 0, blocked: 0 }, message: '' };
    if (intent.authority !== authority) {
      next.bots[appId] = { ...summary, phase: 'blocked', message: redacted.authority_changed }; continue;
    }
    const files = (await readdir(join(base(home), 'topics', appId)).catch(() => []))
      .filter(name => uuid.test(name.replace(/\.json$/, '')));
    const states = { ...(prior.bots?.[appId]?.revision === intent.revision ? prior.bots[appId].topics : {}) };
    const active = files.filter(name => {
      const row = rows.get(name.slice(0, -5));
      return row?.larkAppId === appId && !['closed', 'expired', 'deleted'].includes(row.status);
    });
    const start = cursors.get(`${home}:${appId}`) || 0;
    for (let n = 0; n < Math.min(active.length, 4); n++) {
      const sid = active[(start + n) % active.length].slice(0, -5);
      const topic = readTopic(home, appId, sid);
      try { states[sid] = await reconcileTopicRouting(home, topic, intent, deps); }
      catch { states[sid] = { phase: 'waiting', message: redacted.waiting_idle, revision: intent.revision }; }
    }
    cursors.set(`${home}:${appId}`, active.length ? (start + 4) % active.length : 0);
    const activeIds = active.map(name => name.slice(0, -5));
    summary.topics = Object.fromEntries(activeIds.filter(sid => states[sid]).map(sid => [sid, states[sid]]));
    for (const sid of activeIds) {
      const phase = states[sid]?.phase || 'waiting';
      if (phase in summary.counts) summary.counts[phase]++;
      else summary.counts.waiting++;
    }
    summary.phase = summary.counts.blocked ? 'blocked' : summary.counts.switching ? 'switching'
      : summary.counts.waiting ? 'waiting' : 'verified';
    summary.message = summary.phase === 'verified'
      ? `已核验 ${summary.counts.verified} 个旧话题的实际线路`
      : Object.values(summary.topics).find(v => v.phase === summary.phase)?.message || redacted.waiting_idle;
    next.bots[appId] = summary;
  }
  await atomicJson(statusFile(home), next);
}
