import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, statSync, linkSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const sha256 = data => createHash('sha256').update(data).digest('hex');

export function uuidv7(now = Date.now()) {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(now, 0, 6);
  bytes[6] = (bytes[6] & 15) | 0x70;
  bytes[8] = (bytes[8] & 63) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function containsEncryptedState(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsEncryptedState);
  return Object.entries(value).some(([key, entry]) =>
    key === 'encrypted_content' && entry != null || containsEncryptedState(entry));
}

export function buildNativeHistory(data, { model, sourceId, sourceProvider, targetProvider = 'trae', effort, backendVariant, id = uuidv7(), now = new Date(), resolveBlob } = {}) {
  if (!uuid.test(id)) throw new Error('Target must have a fresh UUIDv7');
  const modelValid = targetProvider === 'trae' ? /^GPT-[\w.-]+$/.test(model || '')
    : targetProvider === 'botmux_ferry' && /^ferry-gpt-[a-z0-9-]+$/.test(model || '');
  if (!modelValid || !['minimal','low','medium','high','xhigh','ultra'].includes(effort)
    || !['standard','max'].includes(backendVariant)) throw new Error('A verified native model, effort and variant are required');
  if (!uuid.test(sourceId || '') || !/^[a-zA-Z0-9_-]+$/.test(sourceProvider || '')
    || sourceProvider === 'openai' || sourceProvider === 'trae' && targetProvider !== 'botmux_ferry') throw new Error('An explicit compatible source binding is required');
  const providerChanged = sourceProvider !== targetProvider;
  const text = Buffer.isBuffer(data) ? data.toString('utf8') : data;
  if (Buffer.byteLength(text) > 64 * 1024 * 1024
    || Buffer.isBuffer(data) && !Buffer.from(text).equals(data)) throw new Error('Source size or UTF-8 encoding is invalid');
  if (!text.endsWith('\n')) throw new Error('Source has an incomplete trailing record; wait for the task to finish');
  const records = text.trimEnd().split('\n').map(line => JSON.parse(line));
  const source = records[0]?.payload;
  if (records[0]?.type !== 'session_meta' || !uuid.test(source?.id ?? '')) throw new Error('Invalid source session header');
  if (source.id !== sourceId || source.model_provider !== sourceProvider) throw new Error('Source does not match the authorized gateway history');
  if (source.history_format !== 'canonical_v1') throw new Error('Unsupported history format; source left unchanged');
  if (source.id === id) throw new Error('Migration must not reuse the original session id');
  let active = [], mutations = 0;
  for (const record of records.slice(1)) {
    if (record.type === 'response_item' || record.type === 'compacted') throw new Error('Mixed history format is unsupported');
    if (record.type !== 'history_mutation') continue;
    const payload = record.payload;
    if (payload?.version !== 1 || !Array.isArray(payload.items)) throw new Error('Invalid history mutation');
    if (payload.operation === 'replace') active = payload.items.slice();
    else if (payload.operation === 'append') active.push(...payload.items);
    else throw new Error(`Unsupported history mutation: ${payload.operation}`);
    mutations++;
  }
  if (!mutations || !active.length) throw new Error('Source has no model-visible history');
  const items = [], calls = new Set(), outputs = new Set(), blobs = new Map();
  const lastMutationIndex = records.findLastIndex(record => record.type === 'history_mutation');
  const lastBoundaryIndex = records.findLastIndex(record => record.type === 'event_msg'
    && ['task_started', 'task_complete', 'turn_aborted'].includes(record.payload?.type));
  const terminal = records[lastBoundaryIndex];
  if (lastBoundaryIndex <= lastMutationIndex
    || !['task_complete', 'turn_aborted'].includes(terminal?.payload?.type)
    || typeof terminal.payload.turn_id !== 'string' || !terminal.payload.turn_id
    || !Number.isFinite(Date.parse(terminal.timestamp))) {
    throw new Error('Source has no final completed or aborted boundary after its visible history; wait for idle');
  }
  let blobBytes = 0;
  const materialize = value => {
    if (Array.isArray(value)) return value.map(materialize);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, materialize(entry)]));
    if (typeof value !== 'string' || !value.startsWith('traex-rollout-blob:')) return value;
    const match = value.match(/^traex-rollout-blob:v1:sha256:([a-f0-9]{64}):(\d+)$/);
    if (!match || !resolveBlob) throw new Error('Visible history has an unresolved rollout blob');
    if (blobs.has(match[1])) return blobs.get(match[1]);
    const size = Number(match[2]);
    if (size > 16 * 1024 * 1024 || blobBytes + size > 64 * 1024 * 1024) throw new Error('Visible rollout blobs exceed the bounded migration size');
    const bytes = resolveBlob({ sha256: match[1], bytes: size });
    if (!Buffer.isBuffer(bytes) || bytes.length !== size || sha256(bytes) !== match[1]) throw new Error('Visible rollout blob integrity check failed');
    const text = bytes.toString('utf8');
    if (!Buffer.from(text).equals(bytes)) throw new Error('Visible rollout blob is not UTF-8 text');
    blobs.set(match[1], text);
    blobBytes += size;
    return text;
  };
  const counts = { messages: 0, user: 0, developer: 0, assistant: 0, system: 0, toolCalls: 0, toolOutputs: 0, reasoningRemoved: 0,
    providerStateRemoved: 0 };
  for (const item of active) {
    // Native Trae stores opaque provider continuation/cache state separately
    // from user-visible messages. It is not portable to another provider.
    // Recognize only this exact structural item, not arbitrary "extra" content.
    if (item.type === 'trae_extra_info') {
      if (typeof item.id !== 'string' || !item.extra_info || typeof item.extra_info !== 'object'
        || Array.isArray(item.extra_info) || Object.keys(item).some(k => !['type', 'id', 'extra_info'].includes(k))) {
        throw new Error('Unsupported native provider state; source left unchanged');
      }
      if (providerChanged) counts.providerStateRemoved++;
      else items.push(materialize(item));
      continue;
    }
    if (item.type === 'reasoning') {
      if (providerChanged) counts.reasoningRemoved++;
      else items.push(materialize(item));
      continue;
    }
    if (providerChanged && containsEncryptedState(item)) throw new Error('Encrypted state in an unknown item; source left unchanged');
    if (item.type === 'message') {
      if (!['user', 'developer', 'assistant', 'system'].includes(item.role) || !Array.isArray(item.content)) throw new Error('Unsupported message');
      counts.messages++;
      counts[item.role]++;
    } else if (['function_call', 'custom_tool_call'].includes(item.type)) {
      if (!item.call_id || calls.has(item.call_id) || outputs.has(item.call_id)) throw new Error('Invalid or duplicate tool call');
      calls.add(item.call_id);
      counts.toolCalls++;
    } else if (['function_call_output', 'custom_tool_call_output'].includes(item.type)) {
      if (!calls.has(item.call_id) || outputs.has(item.call_id)) throw new Error('Unpaired or duplicate tool result');
      outputs.add(item.call_id);
      counts.toolOutputs++;
    } else throw new Error(`Unsupported history item: ${item.type}`);
    // Provider response metadata is not portable. Message content and completed
    // tool calls/results remain verbatim; no summarizer or tool re-execution.
    const copy = { ...item };
    if (providerChanged) delete copy.internal_chat_message_metadata_passthrough;
    items.push(materialize(copy));
  }
  if (calls.size !== outputs.size) throw new Error('History contains an unfinished tool call; wait for the task to finish');
  if (!counts.user) throw new Error('Source has no user messages');
  const timestamp = now.toISOString();
  const header = { ...source, id, session_id: id, timestamp, model_provider: targetProvider, forked_from_id: source.id,
    context_window: { window_id: id } };
  // Restore current native model instructions rather than persisted Ferry
  // model provenance. Historical developer messages remain in the snapshot.
  if (providerChanged) delete header.base_instructions;
  const recordsOut = [
    { timestamp, ordinal: 0, type: 'session_meta', payload: header },
    { timestamp, ordinal: 1, type: 'history_mutation', payload: { version: 1, commit_id: randomUUID(), operation: 'append', items } },
    // Preserve a real source terminal, not a fabricated completion or prompt.
    // Without it a later cold-resume scan mistakes the snapshot for live work.
    { ...terminal, ordinal: 2, payload: materialize(terminal.payload) },
  ];
  const output = recordsOut.map(record => JSON.stringify(record)).join('\n') + '\n';
  if (Buffer.byteLength(output) > 64 * 1024 * 1024) throw new Error('Converted history exceeds the bounded migration size');
  return { output, manifest: { version: 1, mode: 'native-visible-history-copy', sourceId: source.id, targetId: id,
    sourceProvider: source.model_provider, targetProvider, targetModel: model, sourceSha256: sha256(data),
    targetSha256: sha256(output), sourceBytes: Buffer.byteLength(data), targetBytes: Buffer.byteLength(output),
    sourceMutations: mutations, activeItems: active.length, retainedItems: items.length, counts,
    visibleBlobsMaterialized: blobs.size, visibleBlobBytes: blobBytes,
    sourceUnmodified: true, modelSummaryGenerated: false, encryptedReasoningPortable: !providerChanged,
    contextBoundary: 'Preserves the active visible snapshot, not encrypted reasoning or pre-compaction discarded turns',
    sourceTerminalPreserved: true, sourceTerminalType: terminal.payload.type,
    sourceTerminalTimestamp: terminal.timestamp, targetEffort: effort, targetBackendVariant: backendVariant, createdAt: timestamp } };
}

export function createNativeHistory(sourcePath, targetRoot, options = {}) {
  const source = resolve(sourcePath), root = resolve(targetRoot);
  if (statSync(source).size > 64 * 1024 * 1024) throw new Error('Source exceeds the bounded migration size');
  const data = readFileSync(source);
  if (options.expectedSourceSha256 && sha256(data) !== options.expectedSourceSha256) throw new Error('Source does not match the approved migration snapshot');
  const result = buildNativeHistory(data, { ...options,
    resolveBlob: ({ sha256: digest, bytes }) => {
      const path = join(source.replace(/\.jsonl$/, '.artifacts'), 'rollout-blobs', 'sha256', digest.slice(0, 2), digest);
      if (statSync(path).size !== bytes) throw new Error('Visible rollout blob size mismatch');
      return readFileSync(path);
    } });
  const date = new Date(result.manifest.createdAt);
  const dir = join(root, 'sessions', String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
  const name = `rollout-${date.toISOString().slice(0, 19).replaceAll(':', '-')}-${result.manifest.targetId}.jsonl`;
  const target = join(dir, name);
  if (existsSync(target)) throw new Error('Target history already exists');
  if (sha256(readFileSync(source)) !== result.manifest.sourceSha256) throw new Error('Source changed while preparing; retry after the task is idle');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}.tmp`, manifestPath = `${target}.migration.json`;
  const manifestTemporary = `${manifestPath}.${randomUUID()}.tmp`;
  let targetCreated = false, manifestCreated = false;
  result.manifest.sourcePath = source;
  result.manifest.targetPath = target;
  result.manifest.sourceIdleVerified = false;
  try {
    writeFileSync(temporary, result.output, { flag: 'wx', mode: 0o600 });
    writeFileSync(manifestTemporary, JSON.stringify(result.manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    // Same-directory hard links publish complete files without replacing an
    // existing target, including during concurrent preparation of the same id.
    linkSync(temporary, target);
    targetCreated = true;
    linkSync(manifestTemporary, manifestPath);
    manifestCreated = true;
    if (sha256(readFileSync(source)) !== result.manifest.sourceSha256) throw new Error('Source changed before publishing migration; retry when idle');
    return { ...result.manifest, manifestPath };
  } catch (error) {
    if (manifestCreated) unlinkSync(manifestPath);
    if (targetCreated) unlinkSync(target);
    throw error;
  } finally {
    for (const path of [temporary, manifestTemporary]) if (existsSync(path)) unlinkSync(path);
  }
}
