import { request } from './common.mjs';

export function mergeSnapshot(previous, incoming) {
  if (!incoming) return previous;
  if (!previous) return incoming;
  const newerScope = (incoming.scopeRevision || 0) >= (previous.scopeRevision || 0);
  let next;
  if (incoming.scopeOnly) {
    const patches = new Map((incoming.profiles || []).map(profile => [profile.appId, profile]));
    next = { ...previous, ...incoming, scopeOnly: previous.scopeOnly,
      runtime: previous.runtime, setup: { ...previous.setup, ...incoming.setup },
      profiles: (previous.profiles || incoming.profiles || []).map(profile => {
        const patch = newerScope && patches.get(profile.appId);
        return patch ? { ...profile, ...patch, connection: { ...profile.connection, ...patch.connection } } : profile;
      }) };
  } else {
    next = { ...incoming };
    const olderFullRead = (incoming.scopeRevision || 0) === (previous.scopeRevision || 0)
      && Number.isFinite(incoming.observedAt) && Number.isFinite(previous.observedAt)
      && incoming.observedAt < previous.observedAt;
    if (!newerScope || olderFullRead) {
      // Stale full responses can regress capabilities/runtime as well as the
      // checkbox. Only independently versioned job/check progress may merge.
      next = { ...previous, versionCheck: incoming.versionCheck || previous.versionCheck,
        setup: { ...previous.setup, job: incoming.setup?.job || previous.setup?.job } };
    }
  }
  if (!newerScope) {
    next.scopeRevision = previous.scopeRevision; next.defaults = previous.defaults; next.configRevision = previous.configRevision;
  }
  const oldCheck = previous.versionCheck, check = incoming.versionCheck;
  if (oldCheck && (!check || (oldCheck.startedAt || 0) > (check.startedAt || 0)
    || (oldCheck.id === check.id && oldCheck.state !== 'checking' && check.state === 'checking'))) next.versionCheck = oldCheck;
  const oldJob = previous.setup?.job, job = incoming.setup?.job;
  if (oldJob && (!job || (oldJob.startedAt || 0) > (job.startedAt || 0)
    || (oldJob.id === job.id && oldJob.state !== 'running' && job.state === 'running'))) {
    next.setup = { ...next.setup, job: oldJob };
  } else if (oldJob?.id && oldJob.id === job?.id && Number.isFinite(oldJob.percent) && Number.isFinite(job.percent)) {
    next.setup = { ...next.setup, job: { ...job, percent: Math.max(oldJob.percent, job.percent) } };
  }
  return next;
}

export async function readState(api) {
  const value = api?.saveSettings ? await api.saveSettings({ action: 'read-state' })
    : await request('/api/plugins/gateway-acceleration/settings', 'PUT', { action: 'read-state' },
      { signal: AbortSignal.timeout(5000) });
  if (value.ok === false || !value.state) throw new Error(value.error || '无法读取网关状态');
  return value.state;
}

const eventName = 'botmux-gateway-state-changed';
const channel = typeof window !== 'undefined' && typeof BroadcastChannel === 'function' ? new BroadcastChannel(eventName) : null;
export function announceStateChange() {
  window.dispatchEvent(new Event(eventName));
  channel?.postMessage({ changed: true });
}
export function subscribeStateChange(callback) {
  window.addEventListener(eventName, callback);
  channel?.addEventListener('message', callback);
  window.addEventListener('focus', callback);
  return () => {
    window.removeEventListener(eventName, callback);
    channel?.removeEventListener('message', callback);
    window.removeEventListener('focus', callback);
  };
}
