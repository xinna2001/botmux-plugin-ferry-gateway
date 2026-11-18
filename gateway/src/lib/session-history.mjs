import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const nativeProviders = new Set(['trae', 'openai']);
const efforts = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'ultra']);
const ferryModel = value => typeof value === 'string' && /^ferry-gpt-[a-z0-9-]+$/.test(value);

export function expectedPendingFromTopic(topic, request) {
  if (topic?.scopeEnabled !== true || request?.primary !== true || request.controlProtocol !== 1
    || request.generated !== false || request.appId !== topic.appId || request.sessionId !== topic.sessionId
    || !['queued', 'waiting', 'error'].includes(request.phase)
    || !uuid.test(request.nativeSessionId || '')
    || request.model !== topic.binding?.selection?.ferryModel
    || request.reasoningEffort !== topic.bot?.reasoningEffort) return undefined;
  return { nativeSessionId: request.nativeSessionId, model: request.model,
    effort: request.reasoningEffort, provider: topic.provider || 'botmux_ferry',
    confirmedNonGeneratingRequest: true };
}

export async function historyFile(id, root) {
  if (!uuid.test(id || '') || !isAbsolute(root || '')) return null;
  let scanned = 0;
  async function find(dir, depth) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      if (++scanned > 10000) throw new Error('会话线路检查超出范围');
      if (entry.isDirectory() && depth < 3 && /^\d{2,4}$/.test(entry.name)) {
        const found = await find(join(dir, entry.name), depth + 1);
        if (found) return found;
      } else if (entry.isFile() && entry.name.endsWith(`-${id}.jsonl`)) {
        return join(dir, entry.name);
      }
    }
    return null;
  }
  return find(root, 0);
}

// Stream the whole history, not only its header or last turn. A process killed
// during a write may leave an incomplete final line; completed earlier turns
// remain usable. Malformed complete records and excessive inputs fail closed.
async function* records(file) {
  let pending = Buffer.alloc(0), bytes = 0;
  for await (const chunk of createReadStream(file)) {
    bytes += chunk.length;
    if (bytes > 512 * 1024 * 1024) throw new Error('会话历史过大，无法核验恢复配置');
    pending = Buffer.concat([pending, chunk]);
    let end;
    while ((end = pending.indexOf(10)) >= 0) {
      const line = pending.subarray(0, end).toString('utf8');
      pending = pending.subarray(end + 1);
      if (line.trim()) yield JSON.parse(line);
    }
    if (pending.length > 16 * 1024 * 1024) throw new Error('会话历史记录过大，无法核验恢复配置');
  }
  if (pending.length) {
    let value;
    try { value = JSON.parse(pending.toString('utf8')); }
    catch { return; }
    yield value;
  }
}

function containsOutput(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 8) return false;
  if (value.role === 'assistant' || ['function_call', 'custom_tool_call', 'reasoning'].includes(value.type)) return true;
  return Object.values(value).some(v => Array.isArray(v)
    ? v.some(x => containsOutput(x, depth + 1)) : containsOutput(v, depth + 1));
}

export async function successfulHistoryConfiguration(id, root, { expectedPending } = {}) {
  const file = await historyFile(id, root);
  if (!file) return null;
  let meta, active, sequence = 0;
  const turns = new Map();
  const completed = [];
  for await (const record of records(file)) {
    const value = record.payload || {};
    if (record.type === 'session_meta') {
      if (value.id !== id) throw new Error('会话历史身份不匹配，未恢复其他会话');
      meta ||= value;
    } else if (record.type === 'turn_context') {
      if (value.root_turn_id && value.turn_id && value.root_turn_id !== value.turn_id) continue;
      active = value.turn_id || active || 'legacy';
      const previous = turns.get(active);
      const turn = previous && !previous.completed ? previous : {};
      const settings = value.collaboration_mode?.settings || {};
      const effort = value.effort ?? value.model_reasoning_effort ?? settings.reasoning_effort;
      Object.assign(turn, { model: value.model || settings.model,
        provider: value.model_provider || meta?.model_provider, effort,
        turnId: value.turn_id, contextWindow: value.model_context_window,
        ...(['standard', 'max'].includes(value.model_backend_variant)
          ? { backendVariant: value.model_backend_variant } : {}) });
      turns.set(active, turn);
    } else if (record.type === 'response_item' && value.type === 'message'
      && value.role === 'assistant' && value.phase === 'final_answer') {
      const turn = turns.get(active);
      if (turn) { turn.final = true; turn.outputStarted = true; }
    } else if (['response_item', 'history_mutation'].includes(record.type) && containsOutput(value)) {
      const turn = turns.get(active);
      if (turn) turn.outputStarted = true;
    } else if (record.type === 'event_msg') {
      const type = value.type;
      if (type === 'task_started' || type === 'turn_started') {
        if (!value.root_turn_id || value.root_turn_id === value.turn_id) {
          active = value.turn_id || active;
          // A resumed/retried logical ID must not inherit an earlier terminal
          // status. Keep the previous completed candidate as a separate object.
          turns.set(active, {});
        }
      }
      const turn = turns.get(value.turn_id || active);
      if (!turn) continue;
      if (['error', 'stream_error', 'task_failed', 'turn_failed', 'turn_aborted'].includes(type)) turn.failed = true;
      if (type === 'task_complete' || type === 'turn_complete') {
        const final = typeof value.last_agent_message === 'string' && value.last_agent_message.trim().length > 0;
        if ((final || turn.final) && !turn.completed) {
          turn.completed = ++sequence;
          completed.push(turn);
        }
      }
    }
  }
  if (!meta?.model_provider) throw new Error('会话历史缺少 provider，未使用默认配置');
  const successful = completed.filter(turn => !turn.failed
    && typeof turn.model === 'string' && typeof turn.provider === 'string');
  // Once a history has a verified FERRY route, a failed (or default-GPT)
  // fallback must never change that route. Do not borrow fields across turns.
  const firstFerry = successful.filter(turn => ferryModel(turn.model)
    && !nativeProviders.has(turn.provider)).sort((a, b) => a.completed - b.completed)[0];
  const provider = nativeProviders.has(meta.model_provider) ? firstFerry?.provider || meta.model_provider : meta.model_provider;
  const gateway = !nativeProviders.has(provider);
  const selected = successful.filter(turn => turn.provider === provider
    && (!gateway || (ferryModel(turn.model) && efforts.has(turn.effort))))
    .sort((a, b) => b.completed - a.completed)[0];
  if (!selected) {
    // New first turns can be queued forever without a completed answer.
    // Allow only a complete main-turn context whose native identity and all
    // routing fields match the previously recorded primary request + immutable
    // topic binding. Never infer these fields from current Bot defaults.
    const pending = turns.get(active);
    if (expectedPending?.nativeSessionId === id && expectedPending.provider === meta.model_provider
      && expectedPending.provider === 'botmux_ferry' && ferryModel(expectedPending.model)
      && efforts.has(expectedPending.effort) && pending && !pending.completed
      && (!pending.outputStarted || expectedPending.confirmedNonGeneratingRequest === true)
      && pending.model === expectedPending.model && pending.provider === expectedPending.provider
      && pending.effort === expectedPending.effort) {
      return { provider: pending.provider, model: pending.model, effort: pending.effort,
        turnId: pending.turnId, contextWindow: pending.contextWindow, verification: 'bound-unfinished' };
    }
    throw Object.assign(new Error('找不到完整的成功回合配置或可信的首轮排队绑定，未使用失败记录或默认模型恢复'),
      { code: 'NO_VERIFIED_HISTORY_CONFIGURATION' });
  }
  if (!gateway && selected.effort !== undefined && !efforts.has(selected.effort)) {
    throw new Error('历史推理档位无法核验，未使用默认档位');
  }
  return { provider, model: selected.model, effort: selected.effort,
    turnId: selected.turnId, contextWindow: selected.contextWindow,
    ...(selected.backendVariant ? { backendVariant: selected.backendVariant } : {}) };
}
