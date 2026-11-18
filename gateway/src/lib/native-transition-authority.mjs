import { constants, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { digest, validateAppId } from '../../../shared/state.mjs';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export function nativeTransitionFile(home, appId, sessionId) {
  validateAppId(appId);
  if (!uuid.test(sessionId || '')) throw new Error('原生迁移缺少明确话题身份');
  return join(home, 'plugins/gateway-acceleration/private/native-transitions', appId, `${sessionId}.json`);
}
export function nativeTargetReceiptFile(home, appId, sessionId, nativeId) {
  if (!uuid.test(nativeId || '')) throw new Error('原生迁移缺少目标身份');
  return join(nativeTransitionFile(home, appId, sessionId).replace(/\.json$/, ''), `${nativeId}.json`);
}

// Shared with the launcher's full prefix verification. A receipt is a narrowly
// scoped grant for one imported history, not a mutable default or a model alias.
export function transitionChoice(record, topic, appId, sessionId, id) {
  if (!record || topic?.bot?.cliId !== 'traex' || record.schemaVersion !== 1
    || record.authorized !== true || record.appId !== appId || record.sessionId !== sessionId
    || record.targetId !== id || !uuid.test(id || '') || record.topicHash !== digest(topic)
    || !uuid.test(record.sourceId || '') || record.sourceId === id
    || !['prepared', 'accepted', 'verified'].includes(record.state)
    || !['trae', 'botmux_ferry'].includes(record.targetProvider)
    || !Number.isSafeInteger(record.prefixBytes) || record.prefixBytes < 1 || record.prefixBytes > 64 * 1024 * 1024
    || !/^[a-f0-9]{64}$/.test(record.prefixSha256 || '')) return null;
  return (topic.binding?.modelChoices || [topic.binding?.selection]).filter(Boolean)
    .find(c => (record.targetProvider === 'trae'
      ? c.ferryModel === record.sourceModel && c.clientModel === record.targetModel
      : c.ferryModel === record.targetModel && [c.clientModel, c.ferryModel].includes(record.sourceModel))
      && c.backendVariant === record.backendVariant && c.efforts?.includes(record.effort)) || null;
}

// Request-time validation reads only a small owner-only receipt, never the
// potentially 64 MiB history. The launcher/host verify that history before
// switching. Do not follow a substituted receipt symlink or a world-readable file.
export function transitionedTopic(home, topic, turn) {
  if (topic?.bot?.cliId !== 'traex' || !uuid.test(turn.sessionId || '')) return topic;
  let fd;
  try {
    fd = openSync(nativeTargetReceiptFile(home, turn.botmuxAppId, turn.botmuxSessionId, turn.sessionId),
      constants.O_RDONLY | constants.O_NOFOLLOW);
    const identity = fstatSync(fd);
    if (!identity.isFile() || identity.size > 32768 || (identity.mode & 0o077) !== 0
      || typeof process.getuid === 'function' && identity.uid !== process.getuid()) return topic;
    const bytes = Buffer.alloc(32769);
    const size = readSync(fd, bytes, 0, bytes.length, 0);
    if (size > 32768) return topic;
    const record = JSON.parse(bytes.subarray(0, size).toString('utf8'));
    const choice = transitionChoice(record, topic, turn.botmuxAppId, turn.botmuxSessionId, turn.sessionId);
    if (!choice || record.targetProvider !== 'botmux_ferry'
      || record.targetModel !== turn.model?.codexId || record.targetModel !== turn.botmuxRequestedModel
      || record.effort !== turn.reasoningEffort) return topic;
    return { ...topic, scopeEnabled: true,
      bot: { ...topic.bot, model: choice.clientModel, reasoningEffort: record.effort,
        modelBackendVariant: choice.backendVariant },
      binding: { ...topic.binding, acceleration: true, selection: choice } };
  } catch { return topic; }
  finally { if (fd !== undefined) closeSync(fd); }
}
