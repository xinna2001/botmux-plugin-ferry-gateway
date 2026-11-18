#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homePath, getBot, readJson, enabledFor, digest, validateAppId, atomicJson } from '../../../shared/state.mjs';
import { resolveHistoryConfiguration, controlLaunchPlan, needsManagedRuntime } from '../lib/control-launcher.mjs';
import { topicSnapshot, publicBot, defaultBinding, defaultScope, readTopic } from '../lib/topic-state.mjs';
import { servingHealth } from '../lib/managed-runtime.mjs';
import { queuedRecovery } from '../lib/queued-recovery.mjs';
import { expectedPendingFromTopic } from '../lib/session-history.mjs';
import { nativeTransitionHistory } from '../lib/native-transition-receipt.mjs';

async function runtimeHealth(prepared) {
  const runtime = prepared ? await readJson(join(prepared.dataHome, 'runtime.json'), null) : null;
  if (!runtime?.pid || runtime.port !== prepared.port) return { runtime, online: false };
  try {
    const response = await fetch(`http://127.0.0.1:${runtime.port}/_ferry/status`, {
      headers: { 'x-ferry-token': runtime.token }, redirect: 'error', signal: AbortSignal.timeout(2000),
    });
    const value = await response.json();
    return { runtime, online: response.ok && value.pid === runtime.pid && value.port === runtime.port && servingHealth(value).ready };
  } catch { return { runtime, online: false }; }
}

export async function launchManagedClient(argv, env = process.env) {
  if (argv[0] !== '--app' || argv[2] !== '--binding' || argv[4] !== '--') throw new Error('无效的受管启动参数');
  const appId = validateAppId(argv[1]);
  const home = homePath();
  const config = await readJson(join(home, 'plugins/gateway-acceleration/config.json'));
  const binding = defaultBinding(config, appId);
  if (!binding || binding.bindingId !== argv[3]) throw new Error('FERRY 适配记录已变化，请重新打开设置');
  if (digest(await readFile(binding.launcher, 'utf8')) !== binding.launcherHash) throw new Error('FERRY 启动器内容已变化');
  let bot = await getBot(appId, home);
  const args = argv.slice(5);
  const boundary = args.indexOf('--');
  const utilityArgs = boundary < 0 ? args : args.slice(0, boundary);
  const utility = utilityArgs.some(value => ['--version', '-V', '--help', '-h'].includes(value))
    || ['models', 'login', 'logout', 'update', 'doctor', 'features', 'completion', 'help', 'mcp'].includes(utilityArgs[0]);
  const recovery = utility ? null : await queuedRecovery(home, appId, env.BOTMUX_SESSION_ID, args);
  const existingTopic = utility ? null : readTopic(home, appId, env.BOTMUX_SESSION_ID);
  const recorded = existingTopic ? await readJson(join(home, 'plugins/gateway-acceleration/private/requests',
    appId, `${env.BOTMUX_SESSION_ID}.json`), null) : null;
  const expectedPending = expectedPendingFromTopic(existingTopic, recorded);
  let history, transition;
  if (!utility) {
    transition = await nativeTransitionHistory(home, appId, env.BOTMUX_SESSION_ID, args, env, existingTopic);
    try { history = await resolveHistoryConfiguration(bot.cliId, args, env, { expectedPending }); }
    catch (error) {
      if (error.code === 'NO_VERIFIED_HISTORY_CONFIGURATION') {
        history = transition;
      }
      if (!history) {
        if (!recovery?.unfinishedAllowed) throw error;
        history = recovery.history;
      }
    }
  }
  const provider = history?.provider;
  const prepared = await readJson(join(home, 'plugins/gateway-acceleration/private/runtime/prepared.json'), null);
  const nativeScope = await enabledFor('gateway-acceleration', appId, home);
  const scopeEnabled = nativeScope && defaultScope(config, appId, nativeScope);
  const topic = utility ? null : await topicSnapshot(home, appId, env.BOTMUX_SESSION_ID, async () => {
    // Histories that predate 0.6 derive their routing from recorded provider,
    // not from newly changed defaults. Keep the pre-upgrade generation.
    const historical = provider && config.controlPlane?.bots?.[appId] || binding;
    const oldPrepared = provider ? await readJson(join(home,
      'plugins/gateway-acceleration/private/runtime/pre-060.json'), prepared) : prepared;
    const snapshot = { schemaVersion: 1, appId, sessionId: env.BOTMUX_SESSION_ID, createdAt: Date.now(),
      scopeEnabled: provider ? !['openai', 'trae'].includes(provider) : scopeEnabled,
      provider, bot: publicBot(bot), binding: historical, runtime: oldPrepared };
    const health = needsManagedRuntime({ bot, binding: historical, provider, scopeEnabled: snapshot.scopeEnabled })
      ? await runtimeHealth(oldPrepared) : { online: false };
    await controlLaunchPlan({ bot, binding: historical, args, env, provider, history,
      scopeEnabled: snapshot.scopeEnabled, runtime: { online: health.online, port: health.runtime?.port } });
    return snapshot;
  });
  bot = topic?.bot || bot;
  const pinnedBinding = topic?.binding || binding;
  const pinnedRuntime = history?.provider === 'botmux_ferry' && transition?.transitionRuntime
    || recovery?.runtime || topic?.runtime || prepared;
  // OFF/native/help must not wait for or contact a stopped gateway. A settings
  // switch which still makes native launches depend on gateway health is not a
  // usable off switch. Historical FERRY remains a distinct compatibility case.
  const { runtime, online } = !utility && needsManagedRuntime({ bot, binding: pinnedBinding,
    provider: history?.provider || topic?.provider || provider, scopeEnabled: topic?.scopeEnabled ?? scopeEnabled })
    ? await runtimeHealth(pinnedRuntime) : { online: false };
  // Successful native turn evidence takes precedence over a provider-only
  // snapshot captured by an older launcher during a failed/default-GPT resume.
  const plan = await controlLaunchPlan({ bot, binding: pinnedBinding, args, env, history, provider: topic?.provider || provider,
    runtime: { online, port: runtime?.port }, scopeEnabled: topic?.scopeEnabled ?? scopeEnabled,
    pinned: !!topic });
  if (plan.legacy) {
    const legacy = pinnedBinding.native.legacy;
    if (!legacy.runtimeFile) throw new Error('旧会话运行时记录缺失');
    const previous = await readJson(legacy.runtimeFile, null);
    if (!previous || previous.port !== legacy.port) throw new Error('旧会话运行时身份不匹配');
    const response = await fetch(`http://127.0.0.1:${previous.port}/_ferry/status`, {
      headers: { 'x-ferry-token': previous.token }, redirect: 'error', signal: AbortSignal.timeout(2000),
    });
    const value = await response.json();
    if (!response.ok || value.pid !== previous.pid || value.port !== previous.port) throw new Error('旧会话网关未就绪，未切换线路');
  }
  const child = spawn(plan.command, plan.args, { env: plan.env, stdio: 'inherit', shell: false });
  child.once('error', error => { console.error(error.message); process.exitCode = 1; });
  child.once('exit', code => { process.exitCode = code ?? 1; });
  if (plan.gateway && !plan.legacy && history?.provider === 'botmux_ferry') {
    const at = args.findIndex(value => ['resume', '--resume'].includes(value));
    const nativeId = at < 0 ? undefined
      : args.slice(at + 1).find(value => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value));
    if (nativeId) child.once('spawn', () => {
      void atomicJson(join(home, 'plugins/gateway-acceleration/private/runtime-launches', appId, `${env.BOTMUX_SESSION_ID}.json`),
        { schemaVersion: 1, appId, sessionId: env.BOTMUX_SESSION_ID, nativeSessionId: nativeId,
          programHash: pinnedRuntime.programHash, policyHash: pinnedRuntime.policyHash,
          port: runtime?.port, startedAt: Date.now(), pid: child.pid })
        .catch(() => console.error('网关启动核验记录写入失败，未宣称更新完成'));
    });
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await launchManagedClient(process.argv.slice(2));
}
