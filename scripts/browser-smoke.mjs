import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { controlSettings, selectControlModel, setControl } from '../gateway/src/lib/control-plane.mjs';
import { atomicJson, readJson, digest } from '../shared/state.mjs';

const root = join(import.meta.dirname, '..');
const home = await mkdtemp(join(tmpdir(), 'ferry-browser-'));
const output = join(root, 'evidence/browser');
await mkdir(output, { recursive: true });
const bots = [
  { name: '示例 Codex', larkAppId: 'cli_codex_example', cliId: 'codex', model: 'native-example', reasoningEffort: 'xhigh', plugins: ['gateway-acceleration'] },
  { name: '示例 TraeX', larkAppId: 'cli_traex_example', cliId: 'traex', model: 'GPT-6.1-Sol', reasoningEffort: 'xhigh', plugins: ['gateway-acceleration'] },
];
const models = [
  { codex: 'ferry-gpt-6-1-sol', name: 'GPT-6.1-Sol', trae: 'gpt-6.1-sol__dev', context: 475000, efforts: ['medium', 'xhigh'], acceleration_supported: true },
  { codex: 'ferry-gpt-6-1-sol-max', name: 'GPT-6.1-Sol Max', trae: 'gpt-6.1-sol__max', context: 1000000, efforts: ['medium', 'xhigh'], acceleration_supported: true },
];
await atomicJson(join(home, 'bots.json'), bots);
await atomicJson(join(home, 'config.json'), {});
await atomicJson(join(home, 'plugins-registry.json'), { plugins: { 'gateway-acceleration': {} } });
await writeFile(join(home, '.dashboard-token'), 'browser-fixture');
let online = false;
let reloads = 0;
const deps = {
  gatewayModels: async () => models,
  managedRuntimeStatus: async () => ({ online, port: 19879, pid: 1234 }),
  runtimeStatus: async () => ({ ready: true, version: 'Node.js fixture' }),
  setupStatus: async () => ({ installed: true, adapterCompatible: true, authenticated: true, version: '0.1.98' }),
  nativeModelCatalog: async () => ({ models: ['GPT-6.1-Sol'], modelCapabilities: [
    { slug: 'GPT-6.1-Sol', contextVariants: [
      { id: 'standard', contextWindow: 475000, reasoningEfforts: ['medium', 'xhigh'] },
      { id: 'max', contextWindow: 800000, reasoningEfforts: ['medium', 'xhigh'] },
    ] },
  ] }),
  prepareClientCatalog: async () => join(home, 'fixture-models.json'),
  prepareClientBinding: async bot => {
    const launcher = join(home, `${bot.larkAppId}-launch`);
    const source = '#!/bin/sh\nexit 0\n';
    await writeFile(launcher, source, { mode: 0o700 });
    return { architecture: bot.cliId, launcher, launcherHash: digest(source),
      native: { command: process.execPath, prefixArgs: [] } };
  },
};
const bundle = await build({
  stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import Dashboard from './gateway/src/dashboard/gateway.mjs'; createRoot(document.getElementById('root')).render(React.createElement(Dashboard,{api:{react:React}}));`,
    resolveDir: root },
  bundle: true, write: false, platform: 'browser', format: 'esm',
});
const server = createServer(async (req, res) => {
  try {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<meta name="botmux-csrf" content="fixture"><meta name="viewport" content="width=device-width"><div id="root" style="max-width:950px;margin:auto;padding:16px"></div><script type="module" src="/app.js"></script>');
    }
    if (req.url === '/app.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(bundle.outputFiles[0].text); }
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/plugins') return res.end(JSON.stringify({ bots: bots.map(bot => ({ id: bot.larkAppId, name: bot.name })) }));
    if (req.url.startsWith('/api/bots/') && req.url.endsWith('/agent')) {
      assert.equal(req.headers['x-botmux-csrf'], 'fixture');
      assert.match(req.headers.cookie, /browser-fixture/);
      reloads++;
      return res.end('{"ok":true}');
    }
    if (req.url !== '/api/plugins/gateway-acceleration/settings') { res.statusCode = 404; return res.end('{}'); }
    if (req.method === 'GET') return res.end(JSON.stringify(await controlSettings(home, deps)));
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks));
    if (input.action === 'initialize') online = true;
    else if (input.action === 'model') await selectControlModel(input, home, deps);
    else await setControl(input, home, deps);
    return res.end(JSON.stringify({ ok: true, snapshot: await controlSettings(home, deps) }));
  } catch (error) { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: error.message })); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
await writeFile(join(home, '.dashboard-port'), String(server.address().port));
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1150, height: 850 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('heading', { name: '首次配置' }).waitFor();
  assert.equal(await page.locator('.ext-setup .ext-row').count(), 3);
  assert.equal(await page.getByRole('combobox').count(), 0);
  await page.screenshot({ path: join(output, 'first-use.png'), fullPage: true });
  await page.getByRole('button', { name: '完成配置', exact: true }).click();
  await page.getByRole('combobox', { name: '示例 Codex GPT 模型' }).selectOption('ferry-gpt-6-1-sol');
  await page.waitForFunction(() => document.querySelector('[aria-label="示例 Codex 同模型加速"]').disabled === false);
  assert.equal((await readJson(join(home, 'bots.json')))[0].model, 'ferry-gpt-6-1-sol');
  await page.getByRole('switch', { name: '示例 Codex 同模型加速' }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="示例 Codex 同模型加速"]').checked);
  await page.getByRole('switch', { name: '示例 Codex 同模型加速' }).click();
  await page.waitForFunction(() => !document.querySelector('[aria-label="示例 Codex 同模型加速"]').checked);
  assert.ok(await page.getByRole('switch', { name: '示例 Codex 模型转发' }).isChecked());
  await page.getByRole('combobox', { name: '示例 TraeX GPT 模型' }).selectOption('ferry-gpt-6-1-sol-max');
  await page.waitForFunction(() => document.querySelector('[aria-label="示例 TraeX 同模型加速"]').disabled === false);
  await page.getByRole('switch', { name: '示例 TraeX 同模型加速' }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="示例 TraeX 同模型加速"]').checked);
  assert.equal(await page.getByRole('switch').count(), 3);
  assert.ok(await page.locator('.ext-switch span').evaluateAll(elements =>
    elements.every(element => getComputedStyle(element).backgroundColor !== 'rgba(0, 0, 0, 0)')));
  assert.equal((await readJson(join(home, 'bots.json')))[1].modelBackendVariant, 'max');
  assert.equal(await page.locator('.ext-request,table').count(), 0);
  await page.screenshot({ path: join(output, 'settings-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(output, 'settings-mobile.png'), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  assert.equal(reloads, 2);
  assert.deepEqual(errors, []);
  await writeFile(join(output, 'result.json'), JSON.stringify({ passed: true, reloads, errors,
    configuration: 'isolated real files', runtime: 'fixture', productionBotsChanged: false }, null, 2));
  console.log('Browser passed: first-use, model writes, independent controls, desktop/mobile; isolated fixture runtime.');
} finally { await browser.close(); server.close(); await rm(home, { recursive: true, force: true }); }
