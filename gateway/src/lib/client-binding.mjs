import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat, mkdir, writeFile, rename, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { digest, validateAppId } from '../../../shared/state.mjs';
import { detectRuntime } from './runtime.mjs';

const execute = promisify(execFile);
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

function literalPath(value) {
  const text = value?.trim().replace(/^(['"])(.*)\1$/, '$2');
  if (!isAbsolute(text || '') || /[$`\r\n]/.test(text)) return null;
  return text;
}

export async function resolveNativeClient(bot, legacyProfile, deps = {}) {
  if (!['codex', 'traex'].includes(bot.cliId)) throw new Error('当前架构尚未适配');
  if (bot.wrapperCli || bot.cliLaunchMode || bot.readIsolation === true || bot.triggerUserAuth?.enabled === true
    || (bot.sandbox && bot.sandbox !== 'off') || bot.existingAppServer || bot.codexInstancePool
    || (bot.backendType && !['pty', 'tmux'].includes(bot.backendType))) {
    throw new Error('当前 Bot 使用额外封装或身份隔离，未自动接管其启动入口');
  }
  const run = deps.run || execute;
  const configured = bot.cliRuntime?.executable || bot.cliPathOverride;
  let command;
  let prefixArgs = [];
  let legacy;
  if (configured) {
    const details = await stat(configured);
    if (!details.isFile()) throw new Error('当前客户端入口不是普通文件');
    const contents = await readFile(configured);
    const text = contents.subarray(0, 128 * 1024).toString('utf8');
    if (text.startsWith('#!') && legacyProfile?.route?.path === configured
      && legacyProfile.route.sha256 === digest(contents.toString('utf8'))) {
      legacy = { path: configured, hashes: { [configured]: digest(contents.toString('utf8')) },
        providers: [], port: legacyProfile.port,
        runtimeFile: deps.home ? join(deps.home, 'local', legacyProfile.id, 'data/runtime.json') : undefined };
      if (bot.cliId === 'codex') {
        command = literalPath(/^[a-zA-Z0-9_]+_node=(.+)$/m.exec(text)?.[1]);
        const script = literalPath(/^[a-zA-Z0-9_]+_codex=(.+)$/m.exec(text)?.[1]);
        if (!command || !script || !/\/@openai\/codex\/bin\/codex\.js$/.test(script)) throw new Error('现有 Codex 启动器无法安全解析');
        prefixArgs = [script];
        legacy.providers = [...text.matchAll(/model_provider=["']([a-zA-Z0-9_-]+)["']/g)].map(match => match[1]);
      } else {
        const implementation = literalPath(/^exec\s+\S+\s+(\S+)\s+"\$@"\s*$/m.exec(text)?.[1]);
        if (!implementation) throw new Error('现有 TraeX 启动器无法安全解析');
        const source = await readFile(implementation, 'utf8');
        command = literalPath(/const bin = (['"][^'"]+['"]);/.exec(source)?.[1]);
        if (!command) throw new Error('现有 TraeX 原生入口无法安全解析');
        legacy.hashes[implementation] = digest(source);
        legacy.providers = [...source.matchAll(/model_provider=["']([a-zA-Z0-9_-]+)["']/g)].map(match => match[1]);
        if (!source.includes(`http://127.0.0.1:${legacy.port}/v1`)) throw new Error('旧 TraeX 网关地址与登记信息不一致');
      }
      legacy.providers = [...new Set(legacy.providers)].filter(provider => !['openai', 'trae'].includes(provider));
      if (!legacy.providers.length) throw new Error('旧会话 provider 无法核验');
      if (bot.cliId === 'codex' && !text.includes(`http://127.0.0.1:${legacy.port}/v1`)) {
        throw new Error('旧 Codex 网关地址与登记信息不一致');
      }
    } else if (text.startsWith('#!') && !bot.cliRuntime) {
      throw new Error('已有自定义启动器尚未核验，未覆盖其配置');
    } else command = configured;
  } else {
    const located = await run('which', [bot.cliId], { timeout: 5000, maxBuffer: 65536, shell: false });
    command = literalPath(located.stdout.trim());
  }
  if (!command) throw new Error('未找到当前架构的原生客户端');
  command = await realpath(command);
  const result = await run(command, [...prefixArgs, '--version'], { timeout: 10000, maxBuffer: 65536, shell: false });
  const version = result.stdout.trim();
  if (!(bot.cliId === 'codex' ? /codex/i : /trae/i).test(version)) throw new Error('客户端版本身份不匹配');
  if (bot.cliId === 'traex') {
    const help = await run(command, [...prefixArgs, '--help'], { timeout: 10000, maxBuffer: 256 * 1024, shell: false });
    if (!help.stdout.includes('--no-daemon')) throw new Error('此 TraeX 版本缺少独立会话启动能力，未修改配置');
  }
  return { command, prefixArgs, version, legacy };
}

export async function prepareClientBinding(bot, legacyProfile, home, deps = {}) {
  validateAppId(bot.larkAppId);
  const native = await resolveNativeClient(bot, legacyProfile, { ...deps, home });
  const runtime = await (deps.detectRuntime || detectRuntime)(home);
  if (!runtime) throw new Error('请先补足 Node.js 运行环境');
  const directory = join(home, 'plugins/gateway-acceleration/private/clients', bot.larkAppId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const bindingId = randomUUID();
  const launcher = join(directory, 'launch');
  const entry = deps.clientEntry || fileURLToPath(new URL('../bin/managed-client.mjs', import.meta.url));
  const source = `#!/bin/sh\nexec ${quote(runtime.node)} ${quote(entry)} --app ${quote(bot.larkAppId)} --binding ${quote(bindingId)} -- "$@"\n`;
  const staged = `${launcher}.${bindingId}.tmp`;
  await writeFile(staged, source, { mode: 0o700, flag: 'wx' });
  await rename(staged, launcher);
  return {
    bindingId, architecture: bot.cliId, launcher, launcherHash: digest(source), native,
    previousCliPathOverride: bot.cliPathOverride,
    previousCliRuntime: bot.cliRuntime,
    preparedAt: Date.now(),
  };
}

export function bindingPatch(bot, binding) {
  return {
    cliPathOverride: binding.launcher,
    ...(bot.cliRuntime ? { cliRuntime: { ...bot.cliRuntime, executable: binding.launcher } } : {}),
  };
}
