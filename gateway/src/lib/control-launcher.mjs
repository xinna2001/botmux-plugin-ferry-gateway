import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { randomUUID } from 'node:crypto';
import { digest } from '../../../shared/state.mjs';
import { historyProvider } from './client-launcher.mjs';

const modelKeys = new Set(['model', 'model_provider', 'model_backend_variant', 'model_reasoning_effort',
  'model_context_window', 'model_auto_compact_token_limit', 'model_catalog_json']);
const utilityCommands = new Set(['models', 'login', 'logout', 'update', 'doctor', 'features', 'completion', 'help', 'mcp']);

export function withoutModelOverrides(args) {
  const boundary = args.indexOf('--');
  const before = boundary < 0 ? args : args.slice(0, boundary);
  const after = boundary < 0 ? [] : args.slice(boundary);
  const result = [];
  for (let index = 0; index < before.length; index++) {
    const argument = before[index];
    if (argument === '-m' || argument === '--model') { index++; continue; }
    if (argument.startsWith('--model=')) continue;
    if (argument === '-c' || argument === '--config' || argument.startsWith('--config=')) {
      const inline = argument.startsWith('--config=');
      const value = inline ? argument.slice(9) : before[++index];
      const parsed = parse(value);
      const keys = Object.keys(parsed);
      if (keys.some(key => modelKeys.has(key))) {
        if (keys.length !== 1) throw new Error('不支持混合模型覆盖参数，请拆分配置后重试');
        continue;
      }
      if (inline) result.push(argument);
      else result.push(argument, value);
    } else result.push(argument);
  }
  return { before: result, after };
}

function overrides(values) {
  const result = [];
  const emit = (value, path = []) => {
    for (const [key, item] of Object.entries(value)) {
      const next = [...path, key];
      if (!/^[a-zA-Z0-9_-]+$/.test(key)) throw new Error('客户端配置键无效');
      if (item && typeof item === 'object' && !Array.isArray(item)) emit(item, next);
      else result.push('-c', `${next.join('.')}=${JSON.stringify(item)}`);
    }
  };
  emit(values);
  return result;
}

function providerConfiguration(bot, env, port, provider) {
  return {
    model_provider: provider,
    model_providers: { [provider]: {
      name: 'FERRY', base_url: `http://127.0.0.1:${port}/v1`, wire_api: 'responses',
      http_headers: { 'x-botmux-app': bot.larkAppId, 'x-ferry-client': bot.cliId,
        'x-botmux-session': env.BOTMUX_SESSION_ID || randomUUID() },
      auth: { command: 'printf', args: ['ferry'] },
    } },
  };
}

export async function resolveHistoryProvider(architecture, args, env) {
  const boundary = args.indexOf('--');
  const before = boundary < 0 ? args : args.slice(0, boundary);
  const location = before.findIndex(value => ['resume', 'fork', '--resume', '--fork'].includes(value));
  if (location < 0) return undefined;
  const id = before.slice(location + 1).find(value => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value));
  if (!id) throw new Error('恢复旧会话需要明确的会话 ID，未切换原线路');
  const roots = architecture === 'codex'
    ? [join(env.CODEX_HOME || join(homedir(), '.codex'), 'sessions')]
    : env.TRAECLI_HOME ? [join(env.TRAECLI_HOME, 'sessions')]
      : env.TRAE_HOME ? [join(env.TRAE_HOME, 'sessions'), join(env.TRAE_HOME, 'cli/sessions')]
        : [join(homedir(), '.trae/cli/sessions')];
  for (const root of roots) {
    const provider = await historyProvider(id, root);
    if (provider) return provider;
  }
  throw new Error('无法核验旧会话 provider，未切换或迁移历史');
}

export async function controlLaunchPlan({ bot, binding, args, env, runtime, provider, scopeEnabled }) {
  const native = binding.native;
  const base = extra => ({ command: native.command, args: [...native.prefixArgs, ...extra], env, gateway: false });
  if (args.some(value => ['--version', '-V', '--help', '-h'].includes(value)) || utilityCommands.has(args[0])) return base(args);
  const clean = withoutModelOverrides(args);
  if (provider && binding.native.legacy?.providers.includes(provider)) {
    for (const [file, expected] of Object.entries(binding.native.legacy.hashes)) {
      if (digest(await readFile(file, 'utf8')) !== expected) throw new Error('旧会话启动器已变化，未迁移历史');
    }
    if (!Number.isInteger(binding.native.legacy.port)) throw new Error('旧会话网关端口无法核验');
    const configuration = {
      ...providerConfiguration(bot, env, binding.native.legacy.port, provider),
      ...(bot.cliId === 'traex' ? { model_backend_variant: 'standard' } : {}),
    };
    return { command: native.command, args: [...native.prefixArgs,
      ...(bot.cliId === 'traex' && !args.includes('--no-daemon') ? ['--no-daemon'] : []),
      ...clean.before, ...overrides(configuration), ...clean.after], env, gateway: true, legacy: true };
  }
  if (provider && provider !== 'botmux_ferry') {
    const allowed = bot.cliId === 'codex' ? ['openai'] : ['trae'];
    if (!allowed.includes(provider)) throw new Error('旧会话属于其他 provider，未自动接管');
    return base([...clean.before, ...overrides({ model_provider: provider }), ...clean.after]);
  }
  if (!provider && !scopeEnabled) {
    if (String(bot.model || '').startsWith('ferry-')) throw new Error('FERRY 插件尚未对此 Bot 启用；请先选择原生模型');
    return base(args);
  }
  const gateway = provider === 'botmux_ferry'
    || (bot.cliId === 'traex' ? binding.acceleration === true : binding.forwarding === true);
  if (!gateway) {
    if (String(bot.model || '').startsWith('ferry-')) throw new Error('模型转发已关闭；新会话需选择原生模型或重新开启转发');
    return base(args);
  }
  if (!runtime?.online) throw new Error('FERRY 受管运行时未就绪，未改用其他模型');
  const selection = binding.selection;
  if (!provider && (binding.architecture !== bot.cliId || bot.model !== selection?.clientModel
    || (bot.cliId === 'traex' && (bot.modelBackendVariant || 'standard') !== selection.backendVariant)
    || !selection.efforts.includes(bot.reasoningEffort || 'medium'))) {
    throw new Error('当前模型或档位与适配记录不一致，请在 FERRY 设置中重新选择');
  }
  const configuration = {
    ...providerConfiguration(bot, env, runtime.port, 'botmux_ferry'),
    ...(binding.modelCatalog ? { model_catalog_json: binding.modelCatalog } : {}),
    ...(!provider ? { model: selection.ferryModel, model_reasoning_effort: bot.reasoningEffort || 'medium' } : {}),
    ...(bot.cliId === 'traex' ? { model_backend_variant: 'standard',
      ...(!provider ? { model_context_window: selection.contextWindow,
        model_auto_compact_token_limit: Math.floor(selection.contextWindow * 0.95) } : {}) } : {}),
  };
  const interactiveTraex = bot.cliId === 'traex' && !args.some(value => ['exec', 'review', 'app-server'].includes(value));
  return { command: native.command, args: [...native.prefixArgs,
    ...(interactiveTraex && !args.includes('--no-daemon') ? ['--no-daemon'] : []),
    ...clean.before, ...overrides(configuration), ...clean.after], env, gateway: true };
}
