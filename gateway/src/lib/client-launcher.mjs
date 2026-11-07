import { readdir, open } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { parse } from 'smol-toml';
import { readJson } from '../../../shared/state.mjs';

export function clientModelMatches(bot, profile) {
  const client = profile.client;
  if (!client) return bot.model === profile.model;
  return bot.cliId === client.cliId && bot.model === client.model
    && (!client.reasoningEffort || bot.reasoningEffort === client.reasoningEffort)
    && (!client.backendVariant || bot.modelBackendVariant === client.backendVariant);
}
export function managedClient(profile) {
  const value = profile.client;
  return ['codex', 'claude-code', 'traex'].includes(value?.cliId)
    && isAbsolute(value.command || '') && /^[a-z][a-z0-9_]{0,63}$/.test(value.provider || '')
    && typeof value.model === 'string';
}
export async function historyProvider(id, root) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id || '') || !isAbsolute(root || '')) return null;
  let scanned = 0;
  async function find(dir, depth) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (++scanned > 10000) throw new Error('会话线路检查超出范围');
      if (entry.isDirectory() && depth < 3 && /^\d{2,4}$/.test(entry.name)) {
        const value = await find(join(dir, entry.name), depth + 1);
        if (value) return value;
      } else if (entry.isFile() && entry.name.endsWith(`-${id}.jsonl`)) {
        const file = await open(join(dir, entry.name), 'r');
        try {
          const buffer = Buffer.alloc(65536), { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
          return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8').split('\n')[0]).payload?.model_provider || null;
        } finally { await file.close(); }
      }
    }
    return null;
  }
  return find(root, 0);
}
function selectedModel(args) {
  let model, effort;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-m' || arg === '--model') model = args[++i];
    else if (arg.startsWith('--model=')) model = arg.slice(8);
    else if (arg === '-c' || arg === '--config' || arg.startsWith('--config=')) {
      const value = parse(arg.startsWith('--config=') ? arg.slice(9) : args[++i]);
      if (value.model !== undefined) model = value.model;
      if (value.model_reasoning_effort !== undefined) effort = value.model_reasoning_effort;
    }
  }
  return { model, effort };
}
export function buildClientLaunch({ bot, profile, args, forwarding, acceleration, resumedProvider, env = {} }) {
  if (!managedClient(profile) || !clientModelMatches(bot, profile)) throw new Error('当前客户端、模型或档位尚未适配');
  const client = profile.client;
  const boundary = args.indexOf('--'), before = boundary < 0 ? args : args.slice(0, boundary), prompt = boundary < 0 ? [] : args.slice(boundary);
  const selected = selectedModel(before);
  if (selected.model && ![client.model, profile.model].includes(selected.model)) throw new Error('当前会话模型与加速适配不一致');
  if (client.reasoningEffort && selected.effort && selected.effort !== client.reasoningEffort) throw new Error('当前推理档位与加速适配不一致');
  const cold = before.includes('resume') || before.includes('fork');
  if (cold && !resumedProvider) throw new Error('无法核验历史会话线路，未切换会话');
  const requested = bot.cliId === 'traex' ? acceleration : forwarding;
  const gateway = cold ? resumedProvider === client.provider : requested;
  if (cold && resumedProvider !== client.provider && resumedProvider !== client.nativeProvider) throw new Error('历史会话属于其他线路，未切换会话');
  if (!gateway && client.model.startsWith('ferry-')) throw new Error('当前模型仅由 FERRY 提供，请先选择原生模型');
  if (!gateway) return { command: client.command, args, env, gateway: false };
  if (bot.cliId === 'claude-code') return {
    command: client.command, args,
    env: { ...env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${profile.port}`, ANTHROPIC_MODEL: profile.model },
    gateway: true,
  };
  const overrides = {
    model_provider: client.provider, model: profile.model,
    model_providers: { [client.provider]: {
      name: 'FERRY', base_url: `http://127.0.0.1:${profile.port}/v1`, wire_api: 'responses',
      http_headers: { 'x-botmux-app': profile.appId, ...(env.BOTMUX_SESSION_ID ? { 'x-botmux-session': env.BOTMUX_SESSION_ID } : {}) },
      auth: { command: 'printf', args: ['ferry'] },
    } },
    ...(bot.cliId === 'traex' ? { model_backend_variant: 'standard' } : {}),
  };
  // Emit scalar TOML overrides, including quoted header keys, without shell interpolation.
  const flags = [];
  function emit(value, path = []) {
    for (const [key, item] of Object.entries(value)) {
      const next = [...path, key];
      if (item && typeof item === 'object' && !Array.isArray(item)) emit(item, next);
      else flags.push('-c', `${next.map(part => JSON.stringify(part)).join('.')}=${JSON.stringify(item)}`);
    }
  }
  emit(overrides);
  const original = before.filter((arg, index, all) =>
    !['-m', '--model'].includes(arg) && !['-m', '--model'].includes(all[index - 1]) && !arg.startsWith('--model='));
  return { command: client.command, args: [...original, ...flags, '-m', profile.model, ...prompt], env, gateway: true };
}
export async function launchState(bot, profile, home, args, env) {
  const root = join(home, 'local', profile.id);
  const forwarding = (await readJson(join(root, 'forwarding.json'), { enabled: false })).enabled === true;
  const acceleration = bot.model !== 'auto' && bot.traexAutoModel?.enabled !== true
    && (await readJson(join(root, 'acceleration.json'), { enabled: false })).enabled === true;
  const cold = args.findIndex(arg => arg === 'resume' || arg === 'fork');
  const id = cold < 0 ? null : args.slice(cold + 1).find(arg => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(arg));
  const resumedProvider = cold < 0 ? undefined : await historyProvider(id, profile.client?.sessionRoot);
  return buildClientLaunch({ bot, profile, args, forwarding, acceleration, resumedProvider, env });
}
