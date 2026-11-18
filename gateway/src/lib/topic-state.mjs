import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicJson, readJson, withLock, validateAppId } from '../../../shared/state.mjs';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export function topicFile(home, appId, sessionId) {
  validateAppId(appId);
  if (!uuid.test(sessionId || '')) throw new Error('需要明确的话题会话 ID，未应用新的网关配置');
  return join(home, 'plugins/gateway-acceleration/private/topics', appId, `${sessionId}.json`);
}
export function publicBot(bot) {
  return Object.fromEntries(['larkAppId', 'cliId', 'model', 'modelBackendVariant', 'reasoningEffort',
    'plugins', 'traexAutoModel'].filter(key => bot[key] !== undefined).map(key => [key, bot[key]]));
}
export function defaultBinding(config, appId) {
  return config.topicDefaults?.bindings?.[appId] || config.controlPlane?.bots?.[appId];
}
export function defaultScope(config, appId, fallback) {
  const defaults = config.topicDefaults;
  if (defaults?.globalEnabled === true) return true;
  return typeof defaults?.scopes?.[appId] === 'boolean' ? defaults.scopes[appId] : fallback;
}
export async function topicSnapshot(home, appId, sessionId, create) {
  const file = topicFile(home, appId, sessionId);
  const previous = await readJson(file, null);
  if (previous) return validateTopic(previous, appId, sessionId);
  return withLock(file, async () => {
    const concurrent = await readJson(file, null);
    if (concurrent) return validateTopic(concurrent, appId, sessionId);
    const snapshot = await create();
    validateTopic(snapshot, appId, sessionId);
    await atomicJson(file, snapshot);
    return snapshot;
  });
}
export function validateTopic(value, appId, sessionId) {
  if (value?.schemaVersion !== 1 || value.appId !== appId || value.sessionId !== sessionId
    || typeof value.scopeEnabled !== 'boolean' || !value.bot || !value.binding) {
    throw new Error('话题网关快照无效，未重新套用当前开关');
  }
  return value;
}
export function readTopic(home, appId, sessionId) {
  const file = topicFile(home, appId, sessionId);
  try { return validateTopic(JSON.parse(readFileSync(file, 'utf8')), appId, sessionId); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
// An already-running pre-0.6 client may not have passed the new launcher.
// Preserve its first verified request policy; never change it on later turns.
export function legacyPolicySnapshot(home, turn, state) {
  const file = topicFile(home, turn.botmuxAppId, turn.botmuxSessionId);
  const existing = readTopic(home, turn.botmuxAppId, turn.botmuxSessionId);
  if (existing) return existing;
  const snapshot = { schemaVersion: 1, appId: turn.botmuxAppId, sessionId: turn.botmuxSessionId,
    createdAt: Date.now(), legacy: true, scopeEnabled: state.bot.plugins?.includes('gateway-acceleration') === true
      || state.global?.plugins?.includes('gateway-acceleration') === true,
    bot: publicBot(state.bot), binding: state.binding, installed: state.installed };
  validateTopic(snapshot, snapshot.appId, snapshot.sessionId);
  mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
  try { writeFileSync(file, JSON.stringify(snapshot), { mode: 0o600, flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  return readTopic(home, snapshot.appId, snapshot.sessionId);
}
