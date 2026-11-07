#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { homePath, getBot, enabledFor } from '../../../shared/state.mjs';
import { loadProfiles } from '../lib/gateway.mjs';
import { launchState } from '../lib/client-launcher.mjs';

export async function launchClient(appId, args = process.argv.slice(2), env = process.env) {
  const home = homePath();
  const bot = await getBot(appId, home);
  const profile = (await loadProfiles(home)).find(profile => profile.appId === appId);
  if (!profile) throw new Error('未找到此 Bot 的 FERRY 适配');
  const launch = await launchState(bot, profile, home, args, env);
  if (launch.gateway && !await enabledFor('gateway-acceleration', appId, home)) {
    throw new Error('FERRY 插件尚未对此 Bot 启用；原会话未切换');
  }
  const child = spawn(launch.command, launch.args, { env: launch.env, stdio: 'inherit', shell: false });
  child.once('error', error => { console.error(error.message); process.exitCode = 1; });
  child.once('exit', code => { process.exitCode = code ?? 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await launchClient(process.env.BOTMUX_LARK_APP_ID);
}
