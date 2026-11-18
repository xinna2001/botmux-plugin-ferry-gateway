import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

async function adapter() {
  // Bun may canonicalize away a file URL's query string. Use a different,
  // immutable physical filename per build, not ?sha256= cache busting.
  const entry = JSON.parse(await readFile(new URL('./settings-entry.json', import.meta.url), 'utf8'));
  if (!/^[a-f0-9]{64}$/.test(entry.sha256 || '')
    || entry.file !== `settings-${entry.sha256}.mjs`) throw new Error('网关管理模块版本描述无效，请重新安装插件');
  const url = new URL(entry.file, import.meta.url);
  const bytes = await readFile(url);
  if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
    throw new Error('网关管理模块校验失败，请重新安装插件');
  }
  return import(url.href);
}
export async function getSettings(api) { return (await adapter()).getSettings(api); }
export async function saveSettings(api, value) { return (await adapter()).saveSettings(api, value); }
