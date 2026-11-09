#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homePath, getBot, readJson, enabledFor, digest, validateAppId } from '../../../shared/state.mjs';
import { resolveHistoryProvider, controlLaunchPlan } from '../lib/control-launcher.mjs';

export async function launchManagedClient(argv, env = process.env) {
  if (argv[0] !== '--app' || argv[2] !== '--binding' || argv[4] !== '--') throw new Error('无效的受管启动参数');
  const appId = validateAppId(argv[1]);
  const home = homePath();
  const config = await readJson(join(home, 'plugins/gateway-acceleration/config.json'));
  const binding = config.controlPlane?.bots?.[appId];
  if (!binding || binding.bindingId !== argv[3]) throw new Error('FERRY 适配记录已变化，请重新打开设置');
  if (digest(await readFile(binding.launcher, 'utf8')) !== binding.launcherHash) throw new Error('FERRY 启动器内容已变化');
  const bot = await getBot(appId, home);
  const args = argv.slice(5);
  const prepared = await readJson(join(home, 'plugins/gateway-acceleration/private/runtime/prepared.json'), null);
  const runtime = prepared ? await readJson(join(prepared.dataHome, 'runtime.json'), null) : null;
  let online = false;
  if (runtime?.pid && runtime.port === prepared.port) {
    try {
      const response = await fetch(`http://127.0.0.1:${runtime.port}/_ferry/status`, {
        headers: { 'x-ferry-token': runtime.token }, redirect: 'error', signal: AbortSignal.timeout(2000),
      });
      const value = await response.json();
      online = response.ok && value.pid === runtime.pid && value.port === runtime.port;
    } catch {}
  }
  const utility = args.some(value => ['--version', '-V', '--help', '-h'].includes(value));
  const provider = utility ? undefined : await resolveHistoryProvider(bot.cliId, args, env);
  const plan = await controlLaunchPlan({ bot, binding, args, env, provider,
    runtime: { online, port: runtime?.port }, scopeEnabled: await enabledFor('gateway-acceleration', appId, home) });
  if (plan.legacy) {
    const legacy = binding.native.legacy;
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
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await launchManagedClient(process.argv.slice(2));
}
