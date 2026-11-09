import { open, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJson, digest, readJson, validateAppId } from '../../../shared/state.mjs';

export async function managementAuthority(home) {
  const token = (await readFile(join(home, '.dashboard-token'), 'utf8')).trim();
  if (!token) throw new Error('宿主管理身份不可用');
  return digest(token);
}

export async function assertManagementAuthority(home, expected) {
  if (await managementAuthority(home) !== expected) throw new Error('宿主管理身份已变化，请刷新后重试');
}

export async function hostRequest(home, path, method = 'GET', body, fetcher = fetch) {
  if (!path.startsWith('/api/') || path.includes('..')) throw new Error('无效的宿主请求');
  const port = Number((await readFile(join(home, '.dashboard-port'), 'utf8')).trim());
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('宿主面板端口不可用');
  const token = (await readFile(join(home, '.dashboard-token'), 'utf8')).trim();
  if (!token || /[\r\n;]/.test(token)) throw new Error('宿主管理身份不可用');
  const origin = `http://127.0.0.1:${port}`;
  const headers = { Cookie: `botmux_dashboard_token=${token}` };
  if (method !== 'GET') {
    const shell = await fetcher(`${origin}/`, { headers, redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (!shell.ok) throw new Error('无法核验宿主管理身份');
    const csrf = /name="botmux-csrf" content="([^"]+)"/.exec(await shell.text())?.[1];
    if (!csrf) throw new Error('无法核验宿主写入权限');
    Object.assign(headers, { Origin: origin, 'x-botmux-csrf': csrf, 'Content-Type': 'application/json' });
  }
  const response = await fetcher(origin + path, {
    method, headers, redirect: 'error', signal: AbortSignal.timeout(25000),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json();
  if (!response.ok || value.ok === false) throw new Error('宿主未接受此配置，请刷新后重试');
  return value;
}

export async function nativeModelCatalog(bot, home, deps = {}) {
  validateAppId(bot.larkAppId);
  if (!['codex', 'traex'].includes(bot.cliId)) return { models: [], modelCapabilities: [] };
  return (deps.request || hostRequest)(home,
    `/api/cli-options/models?key=${encodeURIComponent(bot.cliId)}&bot=${encodeURIComponent(bot.larkAppId)}`);
}

export async function withBotFileLock(file, callback, options = {}) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + (options.timeoutMs ?? 3000);
  let handle;
  while (!handle) {
    try { handle = await open(lock, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST' || Date.now() >= deadline) throw new Error('另一个操作正在修改 Bot 配置，请稍后重试');
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  }
  const identity = await handle.stat();
  try {
    await handle.writeFile(String(process.pid));
    const current = await stat(lock);
    if (current.ino !== identity.ino || current.dev !== identity.dev) throw new Error('Bot 配置锁已变化');
    return await callback();
  } finally {
    try {
      const current = await stat(lock);
      if (current.ino === identity.ino && current.dev === identity.dev) await unlink(lock);
    } catch {}
    await handle.close();
  }
}

const editableFields = new Set(['model', 'modelBackendVariant', 'cliPathOverride', 'cliRuntime']);

export async function patchBot(home, appId, expectedHash, patch, expectedAuthority) {
  validateAppId(appId);
  for (const field of Object.keys(patch)) if (!editableFields.has(field)) throw new Error('不允许修改此 Bot 字段');
  const file = join(home, 'bots.json');
  return withBotFileLock(file, async () => {
    const bots = await readJson(file, []);
    const position = bots.findIndex(bot => bot.larkAppId === appId);
    if (position < 0 || digest(bots[position]) !== expectedHash) throw new Error('Bot 配置已变化，请刷新重试');
    const previous = structuredClone(bots[position]);
    const next = { ...previous, ...patch };
    for (const [field, value] of Object.entries(patch)) if (value === undefined) delete next[field];
    bots[position] = next;
    if (expectedAuthority) await assertManagementAuthority(home, expectedAuthority);
    await atomicJson(file, bots);
    return { previous, next, fields: Object.keys(patch) };
  });
}

export async function rollbackBot(home, transaction) {
  const file = join(home, 'bots.json');
  return withBotFileLock(file, async () => {
    const bots = await readJson(file, []);
    const position = bots.findIndex(bot => bot.larkAppId === transaction.previous.larkAppId);
    const current = bots[position];
    if (!current || current.cliId !== transaction.previous.cliId
      || transaction.fields.some(field => JSON.stringify(current[field]) !== JSON.stringify(transaction.next[field]))) return false;
    for (const field of transaction.fields) {
      if (Object.hasOwn(transaction.previous, field)) current[field] = transaction.previous[field];
      else delete current[field];
    }
    await atomicJson(file, bots);
    return true;
  });
}

export async function reloadBot(home, bot, deps = {}) {
  validateAppId(bot.larkAppId);
  return (deps.request || hostRequest)(home, `/api/bots/${encodeURIComponent(bot.larkAppId)}/agent`, 'PUT', {
    cliId: bot.cliId, model: bot.model || '', replaceCliSelection: false,
    ...(bot.modelBackendVariant ? { modelBackendVariant: bot.modelBackendVariant } : {}),
    ...(bot.reasoningEffort ? { reasoningEffort: bot.reasoningEffort } : {}),
  });
}
