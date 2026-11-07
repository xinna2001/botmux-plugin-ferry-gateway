import { readFile, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';

export const homePath = () => process.env.BOTMUX_PLUGIN_TEST_HOME || join(homedir(), '.botmux');
export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export async function readJson(file, fallback = {}) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
export async function atomicJson(file, value) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temp, file);
  } finally { await unlink(temp).catch(() => {}); }
}
export async function withLock(file, fn) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  let release;
  try { release = await lockfile.lock(file, { realpath: false, retries: 0, stale: 30000, update: 5000 }); }
  catch { throw new Error('另一个操作正在进行，请稍后重试'); }
  try { return await fn(); } finally { await release(); }
}
export const pluginConfig = (id, home = homePath()) => join(home, 'plugins', id, 'config.json');
export function validateAppId(value) {
  if (typeof value !== 'string' || !/^cli_[a-zA-Z0-9_]{3,80}$/.test(value)) throw new Error('请选择有效的 Bot');
  return value;
}
export async function getBot(appId, home = homePath()) {
  validateAppId(appId);
  const bots = await readJson(join(home, 'bots.json'), []);
  if (!Array.isArray(bots)) throw new Error('Bot 配置格式无效');
  const bot = bots.find(row => row.larkAppId === appId);
  if (!bot) throw new Error('Bot 不存在');
  return bot;
}
export async function enabledFor(id, appId, home = homePath()) {
  const [bot, global, registry] = await Promise.all([
    getBot(appId, home), readJson(join(home, 'config.json')), readJson(join(home, 'plugins-registry.json')),
  ]);
  return !!registry.plugins?.[id] && (global.plugins?.includes(id) === true || bot.plugins?.includes(id) === true);
}
