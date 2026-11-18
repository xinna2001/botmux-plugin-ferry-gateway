import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { bindingModelChoice } from './model-catalog.mjs';
import { readTopic, legacyPolicySnapshot } from './topic-state.mjs';
import { liveControlMonitor } from './live-control.mjs';
import { transitionedTopic } from './native-transition-authority.mjs';

const sessionPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const appPattern = /^cli_[a-zA-Z0-9_]{3,80}$/;
const pluginId = 'gateway-acceleration';
export function requestIsAuxiliary(headers) {
  if (headers.has('x-openai-subagent') || headers.has('x-openai-memgen-request')
    || headers.has('x-codex-guardian')) return true;
  const raw = headers.get('x-codex-turn-metadata');
  if (raw === null) return false; // Older supported clients do not send metadata.
  if (raw.length > 16384) return true;
  try {
    const meta = JSON.parse(raw);
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return true;
    return meta.thread_source !== undefined && meta.thread_source !== 'user'
      || meta.request_kind !== undefined && meta.request_kind !== 'turn';
  } catch { return true; } // Unknown metadata cannot gain control of a parent.
}
export function managedNativeSessionId(headers, fallback) {
  // Native clients may overwrite standard session/cache headers during a
  // fork. This separate managed header comes from the verified resume argv.
  // External forwarding and subagents must retain their own identity rules.
  const nativeId = headers.get('x-botmux-native-session');
  return appPattern.test(headers.get('x-botmux-app') || '')
    && sessionPattern.test(headers.get('x-botmux-session') || '')
    && sessionPattern.test(nativeId || '') && !requestIsAuxiliary(headers)
    && headers.get('x-botmux-forward-only') !== 'true' ? nativeId : fallback;
}
export const RETRY_DELAYS_MS = Object.freeze([5000, 15000, 30000]);
export const REJECTION_TTL_MS = 24 * 60 * 60 * 1000;
export const AFFINITY_TTL_MS = 24 * 60 * 60 * 1000;
export function retryAfterMilliseconds(value, now = Date.now()) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const text = value.trim();
  if (/^[-+]?\d+(?:\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    return seconds >= 0 ? Math.min(seconds * 1000, Number.MAX_SAFE_INTEGER) : undefined;
  }
  if (!/[A-Za-z]{3}/.test(text)) return undefined;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}
export function isTransientAccelerationError(error) {
  const message = String(error?.message ?? '');
  const status = error?.status ?? Number(message.match(/HTTP\s+(\d{3})/i)?.[1]);
  if (status === 401) return false;
  if (status === 403) return /DetectAffiliation|detect affiliation|affiliation correlation/i.test(message)
    && /context deadline exceeded|timed?\s*out|timeout/i.test(message);
  if (status >= 400 && status < 500 && ![408, 429].includes(status)) return false;
  if (/insufficient.{0,20}(quota|credit)|quota.{0,20}exhaust|permission denied|not authorized/i.test(message)) return false;
  return [408, 429].includes(status) || error?.retryable === true
    || /too many requests|exceeded the rate limit|reduce the concurrency/i.test(message);
}
const homePath = () => process.env.BOTMUX_FERRY_CONTROL_HOME || join(homedir(), '.botmux');
const read = (file, fallback) => {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch { return fallback; }
};

export class FerryRoute extends Error {
  constructor(action = 'accelerate') {
    super('same-model-acceleration');
    this.action = action;
  }
}

export function accelerationDecision(turn, { bot, binding, global, installed }) {
  const modelId = turn.model?.codexId;
  if (!installed || !bot || !binding || turn.botmuxSubagent || turn.botmuxForwardOnly) return false;
  if (turn.nativeAccelerationSupported !== true) return false;
  if (!['codex', 'traex'].includes(bot.cliId) || binding.architecture !== bot.cliId) return false;
  if (!bot.plugins?.includes(pluginId) && !global.plugins?.includes(pluginId)) return false;
  if (bot.model === 'auto' || bot.traexAutoModel?.enabled === true) return false;
  if (binding.acceleration !== true || (bot.cliId === 'codex' && binding.forwarding !== true)) return false;
  const selection = bindingModelChoice(bot, binding);
  if (selection?.accelerationAvailable !== true) return false;
  if (!/^ferry-gpt-[a-z0-9-]+$/.test(modelId || '')) return false;
  if (turn.botmuxRequestedModel !== modelId || selection.ferryModel !== modelId) return false;
  if (bot.model !== selection.clientModel) return false;
  if (bot.cliId === 'traex' && (bot.modelBackendVariant || 'standard') !== selection.backendVariant) return false;
  const effort = bot.reasoningEffort || 'medium';
  return turn.reasoningEffort === effort && selection.efforts?.includes(effort) === true;
}

export function createController(turn, deps = {}) {
  // Provider conversation/cache identity may intentionally survive a native
  // fork. Use the launcher's verified native ID only for our scoped policy and
  // receipts; never mutate the upstream turn/session or its replay/cache key.
  if (turn.botmuxNativeSessionId) turn = { ...turn, sessionId: turn.botmuxNativeSessionId };
  if (!appPattern.test(turn.botmuxAppId || '') || !sessionPattern.test(turn.botmuxSessionId || '')) return undefined;
  if (turn.botmuxRequestedModel !== turn.model?.codexId) throw new Error('Requested model does not match the resolved Ferry model');
  const home = deps.home || homePath();
  const config = read(join(home, 'plugins', pluginId, 'config.json'), {});
  const bots = read(join(home, 'bots.json'), []);
  const bot = Array.isArray(bots) ? bots.find(value => value.larkAppId === turn.botmuxAppId) : null;
  const binding = config.controlPlane?.bots?.[turn.botmuxAppId];
  const global = read(join(home, 'config.json'), {});
  const installed = !!read(join(home, 'plugins-registry.json'), {}).plugins?.[pluginId];
  let topic = readTopic(home, turn.botmuxAppId, turn.botmuxSessionId);
  if (!topic && bot && binding) topic = legacyPolicySnapshot(home, turn, { bot, binding, installed, global });
  topic = transitionedTopic(home, topic, turn);
  const enabled = topic ? topic.scopeEnabled && accelerationDecision(turn, {
    bot: { ...topic.bot, plugins: topic.scopeEnabled ? [pluginId] : [] },
    binding: topic.binding, global: {}, installed: topic.installed !== false,
  }) : false;
  const selection = topic && bindingModelChoice(topic.bot, topic.binding);
  const matchesTopic = !!topic && turn.model?.codexId === selection?.ferryModel
    && turn.reasoningEffort === (topic.bot.reasoningEffort || 'medium');
  const monitor = deps.liveMonitor || liveControlMonitor(home);
  // Original policy remains immutable. Only an exact authorized history-copy
  // receipt may grant a transitioned native topic access; live OFF, host scope,
  // and explicit per-topic cancellation still take precedence.
  return new Controller(turn, { ...deps, home, enabled,
    primary: !turn.botmuxSubagent && !turn.botmuxForwardOnly && matchesTopic,
    mayControl: !turn.botmuxSubagent && !turn.botmuxForwardOnly && matchesTopic && topic?.scopeEnabled === true,
    liveControl: () => monitor.get(turn.botmuxAppId),
    subscribeLive: callback => monitor.subscribe(callback),
    enabledNow: () => enabled && (typeof turn.nativeAccelerationPermitted !== 'function'
      || turn.nativeAccelerationPermitted() === true) });
}

export class Controller {
  constructor(turn, deps = {}) {
    this.enabled = deps.enabled === true;
    this.enabledNow = deps.enabledNow || (() => this.enabled);
    const control = join(deps.home || homePath(), 'plugins', pluginId, 'private', 'topic-controls',
      turn.botmuxAppId, `${turn.botmuxSessionId}.json`);
    this.now = deps.now || Date.now;
    this.readControl = deps.readControl || (deps.write && !deps.home ? () => ({}) : () => read(control, {}));
    this.isSuppressed = () => {
      const value = this.readControl();
      if (value.disabled !== true) return false;
      if (['upstream-rejected', 'retry-budget-exhausted'].includes(value.reason)) {
        const until = value.expiresAt ?? (Number.isFinite(value.changedAt) ? value.changedAt + REJECTION_TTL_MS : Infinity);
        return this.now() < until;
      }
      return true; // Manual cancellation and unknown reasons never expire implicitly.
    };
    this.writeControl = deps.writeControl || (deps.write && !deps.home ? () => {} : value => {
      mkdirSync(join(control, '..'), { recursive: true, mode: 0o700 });
      const temp = `${control}.${randomUUID()}.tmp`;
      writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
      renameSync(temp, control);
    });
    this.generated = false;
    this.moved = false;
    this.offerAttempted = false;
    this.failures = 0;
    this.retries = 0;
    this.finished = false;
    this.setTimer = deps.setTimeout || setTimeout;
    this.clearTimeout = deps.clearTimeout || clearTimeout;
    this.signal = turn.signal;
    this.onAbort = () => this.clearAttempt();
    this.signal?.addEventListener('abort', this.onAbort, { once: true });
    // Native title generation and memory consolidation share the provider's
    // botmux-session header with the main turn. They must not replace its
    // queue/effort status. Native request IDs can also be shared by concurrent
    // calls; ownership needs a per-controller identity rather than that ID.
    this.instanceId = randomUUID();
    this.primary = deps.primary !== false && !turn.botmuxSubagent && !turn.botmuxForwardOnly;
    this.mayControl = deps.mayControl !== false && this.primary;
    this.nativeClearRejection = turn.nativeClearRejection;
    this.liveControl = deps.liveControl || (() => ({ enabled: true, revision: 0 }));
    this.live = this.liveControl();
    const affinityFile = join(deps.home || homePath(), 'plugins', pluginId, 'private', 'route-affinity',
      turn.botmuxAppId, `${turn.botmuxSessionId}.json`);
    this.affinityIdentity = { schemaVersion: 1, appId: turn.botmuxAppId, sessionId: turn.botmuxSessionId,
      nativeSessionId: turn.sessionId, model: turn.model?.codexId, reasoningEffort: turn.reasoningEffort };
    this.readAffinity = deps.readAffinity || (deps.write && !deps.home ? () => ({}) : () => read(affinityFile, {}));
    this.writeAffinity = deps.writeAffinity || (deps.write && !deps.home ? () => {} : value => {
      mkdirSync(dirname(affinityFile), { recursive: true, mode: 0o700 });
      const temporary = `${affinityFile}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
      renameSync(temporary, affinityFile);
    });
    this.currentFile = join(deps.home || homePath(), 'plugins', pluginId, 'private',
      this.primary ? 'requests' : 'auxiliary-requests', turn.botmuxAppId, `${turn.botmuxSessionId}.json`);
    this.ownsRequest = deps.write ? () => true
      : () => read(this.currentFile, {}).instanceId === this.instanceId;
    this.write = deps.write || (snapshot => {
      const folder = join(deps.home || homePath(), 'plugins', pluginId, 'private',
        this.primary ? 'requests' : 'auxiliary-requests', turn.botmuxAppId);
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      const target = join(folder, `${turn.botmuxSessionId}.json`);
      const current = read(target, null);
      if (this.initialized && current?.instanceId !== this.instanceId) return;
      const temporary = `${target}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify(snapshot), { mode: 0o600 });
      renameSync(temporary, target);
    });
    this.snapshot = {
      appId: turn.botmuxAppId, sessionId: turn.botmuxSessionId, requestId: turn.requestId,
      nativeSessionId: turn.sessionId,
      instanceId: this.instanceId, primary: this.primary, subagent: !!turn.botmuxSubagent,
      model: turn.model?.codexId, reasoningEffort: turn.reasoningEffort,
      startedAt: this.now(), phase: 'waiting', accelerationEnabled: this.enabled, moved: false,
      accelerationAttempts: 0, accelerationRetries: 0, retryBudget: RETRY_DELAYS_MS.length,
      controlProtocol: 1, liveControlRevision: this.live.revision || 0,
      runtimeGeneration: process.env.FERRY_HOME ? basename(dirname(process.env.FERRY_HOME)) : undefined,
    };
    this.publish();
    this.initialized = true;
    this.unsubscribeLive = deps.subscribeLive?.(() => this.syncLive());
    this.syncLive();
  }
  publish(patch = {}) {
    Object.assign(this.snapshot, patch, { observedAt: this.now(),
      accelerationEnabled: this.enabled && this.live.enabled !== false && this.enabledNow() && !this.isSuppressed(),
      liveControlRevision: this.live.revision || 0, liveAccelerationEnabled: this.live.enabled !== false,
      pauseReason: this.live.reason, generated: this.generated });
    try { this.write({ ...this.snapshot }); } catch {}
  }
  canAccelerate() {
    return this.enabled && this.live.enabled !== false && this.enabledNow() && !this.isSuppressed() && this.ownsRequest()
      && !this.generated && !this.finished && !this.signal?.aborted;
  }
  suppress(reason, options = {}) {
    if (!this.mayControl) return false;
    this.clearAffinity(reason);
    this.clearAttempt();
    this.writeControl({ disabled: true, reason, changedAt: this.now(), controlRevision: this.live.revision || 0,
      ...['upstream-rejected', 'retry-budget-exhausted'].includes(reason)
        ? { expiresAt: Math.max(this.now() + REJECTION_TTL_MS, options.notBefore || 0) } : {},
      ...options.notBefore ? { notBefore: options.notBefore } : {} });
    this.publish({ suppressionReason: reason });
    return true;
  }
  resume() {
    if (!this.mayControl) return false;
    const previous = this.readControl();
    this.nativeClearRejection?.();
    this.failures = 0; this.retries = 0; this.offerAttempted = false;
    this.nextRetryAt = previous.notBefore > this.now() ? previous.notBefore : undefined;
    this.writeControl({ disabled: false, changedAt: this.now(), controlRevision: this.live.revision || 0,
      ...this.nextRetryAt ? { notBefore: this.nextRetryAt } : {} });
    this.publish({ suppressionReason: undefined });
    return true;
  }
  syncLive() {
    if (this.finished) return;
    const previous = this.live;
    this.live = this.liveControl();
    if (this.live.enabled === false) {
      this.clearAffinity('live-off');
      this.cancelTimer();
      this.nextRetryAt = undefined;
      this.publish({ nextRetryAt: undefined });
      if (previous?.enabled !== false) this.notice?.(this.generated
        ? '同模型加速已关闭；当前已开始的回答不中断，后续请求不再加速'
        : '同模型加速已关闭，计划重试已取消；继续普通线路等待');
      if (this.moved && !this.generated) this.abortAttempt?.(new FerryRoute('ordinary'));
      return;
    }
    const saved = this.readControl();
    const explicitNewEnable = this.live.explicitlyEnabled && this.live.revision > (previous?.revision || 0);
    const afterRejection = this.live.explicitlyEnabled && saved.disabled === true
      && ['upstream-rejected', 'retry-budget-exhausted'].includes(saved.reason)
      && (Number.isFinite(saved.controlRevision) ? this.live.revision > saved.controlRevision
        : this.live.changedAt > saved.changedAt);
    if ((explicitNewEnable || afterRejection) && saved.reason !== 'manual-cancel') this.resume();
    this.publish();
    if (explicitNewEnable) this.notice?.(saved.reason === 'manual-cancel'
      ? 'Bot 加速已开启；本话题仍保持手动取消状态'
      : '同模型加速已重新启用；仅在未开始输出且仍在排队时尝试');
    if (explicitNewEnable && this.lastQueue && this.abortAttempt) {
      const route = this.takeOffer();
      if (route) this.abortAttempt(route);
      else this.armRetry();
    }
  }
  setNotice(callback) { this.notice = callback; }
  // Only real accepted output establishes affinity. Never persist endpoint
  // credentials, prompts or an unverified/merely attempted route.
  rememberAffinity() {
    if (!this.mayControl || !this.ownsRequest() || !this.enabled || !this.enabledNow()
      || this.live.enabled === false || this.isSuppressed() || !this.affinityIdentity.nativeSessionId) return false;
    try { this.writeAffinity({ ...this.affinityIdentity, accepted: true, acceptedAt: this.now(),
      liveControlRevision: this.live.revision || 0 }); return true; } catch { return false; }
  }
  clearAffinity(reason) {
    if (!this.mayControl || !this.ownsRequest()) return;
    try { this.writeAffinity({ ...this.affinityIdentity, accepted: false, reason,
      changedAt: this.now(), liveControlRevision: this.live.revision || 0 }); } catch {}
  }
  wantsContinuation() {
    if (!this.primary || !this.canAccelerate() || !this.affinityIdentity.nativeSessionId) return false;
    const saved = this.readAffinity();
    return saved.accepted === true
      && Object.entries(this.affinityIdentity).every(([key, value]) => saved[key] === value)
      && saved.liveControlRevision === (this.live.revision || 0)
      && Number.isFinite(saved.acceptedAt) && saved.acceptedAt <= this.now()
      && this.now() - saved.acceptedAt < AFFINITY_TTL_MS;
  }
  continued() {
    // Recheck after the asynchronous target lookup and before the first wire
    // request. A concurrent OFF/manual cancellation must win this race.
    if (!this.wantsContinuation()) return false;
    this.offerAttempted = true;
    this.continuing = true;
    this.publish({ accelerationAttempts: 1, routeSource: 'conversation-affinity' });
    this.switched();
    return true;
  }
  returnedByControl() {
    this.queueEnded();
    this.moved = false;
    this.publish({ phase: 'waiting', moved: false, routeStatus: 'paused', nextRetryAt: undefined });
  }
  cancelTimer() {
    if (this.timer !== undefined) this.clearTimeout(this.timer);
    this.timer = undefined;
  }
  clearAttempt() {
    this.cancelTimer();
    this.abortAttempt = undefined;
    this.lastQueue = undefined;
  }
  bindAbort(abort) {
    this.clearAttempt();
    this.abortAttempt = abort;
  }
  queueEnded() {
    this.cancelTimer();
    this.lastQueue = undefined;
  }
  hasScheduledRetry() {
    return Number.isFinite(this.nextRetryAt) && this.canAccelerate();
  }
  takeOffer() {
    if (!this.canAccelerate() || this.moved || !this.lastQueue) return;
    if (this.offerAttempted && this.nextRetryAt === undefined) return;
    if (this.nextRetryAt !== undefined && this.now() < this.nextRetryAt) return;
    if (this.nextRetryAt !== undefined && this.offerAttempted) this.retries++;
    this.nextRetryAt = undefined;
    this.offerAttempted = true;
    this.cancelTimer();
    this.publish({ accelerationAttempts: this.retries + 1, accelerationRetries: this.retries,
      nextRetryAt: undefined });
    return new FerryRoute();
  }
  armRetry() {
    if (this.timer !== undefined || !this.abortAttempt || !this.lastQueue || !this.hasScheduledRetry()) return;
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      const route = this.takeOffer();
      if (route) this.abortAttempt?.(route);
      else this.armRetry();
    }, Math.min(2147483000, Math.max(0, this.nextRetryAt - this.now())));
    this.timer?.unref?.();
  }
  queue(position, alternative, moved = false) {
    if (this.generated || this.finished) return;
    this.moved = !!moved;
    this.lastQueue = Number.isFinite(position) && position > 0 && !moved ? { position } : undefined;
    if (!this.lastQueue) this.cancelTimer();
    this.publish({ phase: 'queued', position, alternative, moved: this.moved });
    // An authorized automatic switch needs an observed queue, not a successful
    // speculative probe of the other route. Probe failures/rate limits used to
    // make this switch silently do nothing forever. Never invent an alternative
    // rank. Additional attempts are bounded and only for transient failure.
    const route = this.takeOffer();
    if (route) return route;
    this.armRetry();
  }
  switched() {
    this.queueEnded();
    this.moved = true;
    this.recoveryMessage = undefined;
    this.publish({ phase: 'waiting', moved: true, nextRetryAt: undefined,
      accelerationRetries: this.retries, routeStatus: 'attempting' });
  }
  attemptMessage() {
    return `正在尝试同模型加速${this.retries ? `（重试 ${this.retries}/${RETRY_DELAYS_MS.length}）` : ''}，等待上游接收`;
  }
  acceptanceMessage() {
    return this.snapshot.affinityPersisted
      ? '加速线路已开始返回模型结果；同一会话后续请求将优先沿用该线路'
      : '本次加速已返回模型结果，但未保存会话线路状态；后续请求不能保证沿用';
  }
  returnedToOrdinary(error) {
    this.clearAffinity('route-rejected');
    this.continuing = false;
    this.queueEnded();
    this.moved = false;
    this.offerAttempted = true;
    this.failures++;
    const transient = isTransientAccelerationError(error);
    let delay = RETRY_DELAYS_MS[this.failures - 1];
    // Honor a native Retry-After value if it is available; never shorten it.
    const retryAfter = Number(error?.retryAfterMs);
    if (Number.isFinite(delay) && Number.isFinite(retryAfter) && retryAfter > delay) delay = retryAfter;
    const retry = this.canAccelerate() && transient && delay !== undefined;
    this.nextRetryAt = retry ? this.now() + delay : undefined;
    const reason = !transient ? 'non_retryable' : delay === undefined ? 'retry_budget_exhausted' : 'transient';
    this.recoveryMessage = retry
      ? `加速暂未生效，继续同模型普通排队；${delay / 1000} 秒后重试（${this.retries + 1}/${RETRY_DELAYS_MS.length}）`
      : `加速未生效，继续同模型普通排队；${reason === 'retry_budget_exhausted' ? '三次追加重试已用完' : '本次错误不自动重试'}`;
    const notBefore = Number.isFinite(retryAfter) && retryAfter > 0 ? this.now() + retryAfter : undefined;
    if (!retry && !this.isSuppressed()) this.suppress(
      reason === 'retry_budget_exhausted' ? 'retry-budget-exhausted' : 'upstream-rejected', { notBefore });
    this.publish({ phase: 'waiting', moved: false, routeStatus: 'rejected',
      nextRetryAt: this.nextRetryAt, accelerationRetries: this.retries,
      recoveryReason: reason, failureStatus: error?.status, failureCode: error?.code,
      nativeRetryable: error?.retryable, transient, failureMessage: String(error?.message || '').slice(0, 300) });
    return retry;
  }
  unavailable() {
    this.returnedToOrdinary({ retryable: true, code: 'route_unavailable', message: '加速线路暂不可用' });
  }
  generatedOutput(confirmed = true) {
    if (this.generated && (!confirmed || this.confirmedOutput)) return false;
    this.queueEnded();
    this.generated = true;
    this.confirmedOutput ||= confirmed;
    const affinityPersisted = this.moved && confirmed ? this.rememberAffinity() : this.snapshot.affinityPersisted;
    this.publish({ phase: 'answering', nextRetryAt: undefined,
      affinityPersisted,
      routeStatus: this.moved ? (this.confirmedOutput ? 'accepted' : 'output-unconfirmed') : 'ordinary' });
    // A continued request really used the target, but does not announce a
    // brand-new conversation acceleration after every tool call.
    return confirmed && this.moved && !this.continuing;
  }
  finish(error) {
    if (this.finished) return;
    this.finished = true;
    this.clearAttempt();
    this.unsubscribeLive?.();
    this.notice = undefined;
    this.signal?.removeEventListener('abort', this.onAbort);
    this.publish({ phase: error ? 'error' : 'complete' });
  }
}

export function observeEvent(turn, event, moved) {
  if (event?.type === 'queue') {
    const route = turn.ferryPolicy?.queue(event.position, event.alternative, moved);
    if (route) throw route;
    if (turn.ferryPolicy) return { ...event, alternative: undefined };
  }
  if (event?.type && !['queue', 'waiting', 'started', 'switched', 'notice'].includes(event.type)) {
    // Unknown output conservatively prevents replay, but is not evidence of
    // successful acceleration. Usage/done-only replies cannot create affinity.
    turn.ferryPolicy?.generatedOutput(['text', 'reasoning', 'tool_call', 'search'].includes(event.type));
  }
  return event;
}

export function adaptTraexModelInfo(info, model) {
  return {
    ...info,
    model_provider_id: 'botmux_ferry',
    config_name: String(model.modelName || '').split('__')[0],
    harness_mode: 'codex',
    model_family: 'gpt',
  };
}
