import { join } from 'node:path';
import { homePath, readJson, validateAppId } from '../../../shared/state.mjs';
import { readTopic } from './topic-state.mjs';

export async function currentTopicStatus(home = homePath(), env = process.env, now = Date.now()) {
  const appId = env.BOTMUX_LARK_APP_ID, sessionId = env.BOTMUX_SESSION_ID;
  if (!appId || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(sessionId || '')) return null;
  validateAppId(appId);
  const base = join(home, 'plugins/gateway-acceleration/private');
  const topic = readTopic(home, appId, sessionId);
  if (!topic) return { appId, sessionId, state: 'unbound', liveOffSupported: false };
  const request = await readJson(join(base, 'requests', appId, `${sessionId}.json`), null);
  const control = await readJson(join(base, 'topic-controls', appId, `${sessionId}.json`), null);
  const config = await readJson(join(home, 'plugins/gateway-acceleration/config.json'));
  const fresh = Number.isFinite(request?.observedAt) && now - request.observedAt >= 0
    && now - request.observedAt <= 120000;
  const fields = ['phase', 'model', 'reasoningEffort', 'routeStatus', 'routeSource', 'affinityPersisted', 'moved', 'generated',
    'accelerationEnabled', 'liveAccelerationEnabled', 'liveControlRevision', 'controlProtocol',
    'accelerationAttempts', 'accelerationRetries', 'retryBudget', 'nextRetryAt', 'recoveryReason',
    'failureCode', 'failureStatus', 'pauseReason', 'runtimeGeneration', 'observedAt'];
  return { appId, sessionId, state: request ? fresh ? 'observed' : 'historical' : 'not-observed',
    liveOffSupported: request?.controlProtocol === 1, observationFresh: fresh,
    defaultLiveControl: config.liveControls?.bots?.[appId] || null,
    topicCreationScope: topic.scopeEnabled, topicOriginalRuntimeVersion: topic.runtime?.version,
    request: request ? Object.fromEntries(fields.filter(k => request[k] !== undefined).map(k => [k, request[k]])) : null,
    ...(fresh && request?.phase === 'queued' && request.generated !== true
      && Number.isFinite(request?.position) ? { queuePosition: request.position } : {}),
    topicControl: control ? Object.fromEntries(['disabled','reason','changedAt','expiresAt','notBefore']
      .filter(k => control[k] !== undefined).map(k => [k, control[k]])) : null,
  };
}
