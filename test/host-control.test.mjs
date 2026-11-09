import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from '../shared/state.mjs';
import { patchBot, rollbackBot, withBotFileLock, hostRequest } from '../gateway/src/lib/host-control.mjs';

async function fixture(callback) {
  const home = await mkdtemp(join(tmpdir(), 'ferry-host-control-'));
  const bots = [
    { larkAppId: 'cli_first', cliId: 'codex', model: 'old', plugins: ['gateway-acceleration'], larkAppSecret: 'fixture-secret' },
    { larkAppId: 'cli_second', cliId: 'traex', model: 'unchanged' },
  ];
  await writeFile(join(home, 'bots.json'), JSON.stringify(bots));
  try { await callback(home, bots); } finally { await rm(home, { recursive: true, force: true }); }
}

test('bot update preserves credentials, scope and other Bots', () => fixture(async (home, bots) => {
  const result = await patchBot(home, 'cli_first', digest(bots[0]), { model: 'new' });
  const saved = JSON.parse(await readFile(join(home, 'bots.json'), 'utf8'));
  assert.deepEqual(saved, [{ ...bots[0], model: 'new' }, bots[1]]);
  assert.equal(result.previous.model, 'old');
}));

test('stale model selection and unrelated fields cannot overwrite current configuration', () => fixture(async (home, bots) => {
  await assert.rejects(patchBot(home, 'cli_first', 'stale', { model: 'new' }), /配置已变化/);
  await assert.rejects(patchBot(home, 'cli_first', digest(bots[0]), { plugins: [] }), /不允许/);
  assert.deepEqual(JSON.parse(await readFile(join(home, 'bots.json'), 'utf8')), bots);
}));

test('rollback preserves unrelated edits but refuses to replace a newer model choice', () => fixture(async (home, bots) => {
  const transaction = await patchBot(home, 'cli_first', digest(bots[0]), { model: 'new' });
  const saved = JSON.parse(await readFile(join(home, 'bots.json'), 'utf8'));
  saved[1].name = 'concurrent edit';
  await writeFile(join(home, 'bots.json'), JSON.stringify(saved));
  assert.equal(await rollbackBot(home, transaction), true);
  assert.equal(JSON.parse(await readFile(join(home, 'bots.json'), 'utf8'))[1].name, 'concurrent edit');
  const second = await patchBot(home, 'cli_first', digest(bots[0]), { model: 'new' });
  saved[0].model = 'a newer choice';
  await writeFile(join(home, 'bots.json'), JSON.stringify(saved));
  assert.equal(await rollbackBot(home, second), false);
}));

test('an existing host lock is not stolen', () => fixture(async home => {
  await writeFile(join(home, 'bots.json.lock'), String(process.pid));
  await assert.rejects(withBotFileLock(join(home, 'bots.json'), () => assert.fail('must not enter'),
    { timeoutMs: 1 }), /另一个操作/);
  assert.equal(await readFile(join(home, 'bots.json.lock'), 'utf8'), String(process.pid));
}));

test('host mutation stays on loopback, requires CSRF and disallows redirects', () => fixture(async home => {
  await writeFile(join(home, '.dashboard-port'), '18999');
  await writeFile(join(home, '.dashboard-token'), 'fixture-token');
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    return url.endsWith('/')
      ? new Response('<meta name="botmux-csrf" content="fixture-csrf">')
      : Response.json({ ok: true });
  };
  await hostRequest(home, '/api/bots/cli_first/agent', 'PUT', { cliId: 'codex' }, fetcher);
  assert.equal(calls[1].url, 'http://127.0.0.1:18999/api/bots/cli_first/agent');
  assert.equal(calls[1].options.headers['x-botmux-csrf'], 'fixture-csrf');
  assert.equal(calls[1].options.redirect, 'error');
  await assert.rejects(hostRequest(home, '//unrelated.example', 'GET', undefined, fetcher), /无效/);
}));
