import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { status, setAcceleration, reconcileScopes } from '../lib/gateway.mjs';

const token = process.env.BOTMUX_PLUGIN_CARD_ACTION_TOKEN;
let snapshot;
let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  try { await reconcileScopes(); snapshot = await status(); }
  catch { snapshot = { error: 'gateway_status_unavailable', observedAt: Date.now() }; }
  finally { polling = false; }
}
function authorized(req) {
  if (!token) return false;
  const actual = Buffer.from(String(req.headers.authorization || ''));
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function reply(res, code, data) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}
const server = createServer(async (req, res) => {
  if (req.url === '/healthz' && req.method === 'GET') {
    return reply(res, 200, { ok: true, plugin: 'gateway-acceleration', version: '0.1.0' });
  }
  if (!authorized(req)) return reply(res, 403, { error: 'forbidden' });
  if (req.url === '/botmux/commands/v1' && req.method === 'POST') {
    let size = 0, chunks = [];
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 8192) return reply(res, 413, { error: 'body_too_large' });
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks));
      if (body.privileges?.canTalk !== true) return reply(res, 403, { error: 'forbidden' });
      const args = String(body.args || '').trim().split(/\s+/);
      if (args[0] && args[0] !== 'status') {
        if (body.privileges?.canOperate !== true) return reply(res, 403, { error: 'operator_required' });
        if (!['on', 'off'].includes(args[0])) throw new Error('用法：/gateway status | on | off');
        const current = await status();
        const profile = current.profiles.find(item => item.appId === body.larkAppId);
        if (!profile) throw new Error('此 Bot 尚未接入网关');
        await setAcceleration({ profileId: profile.id, enabled: args[0] === 'on', revision: profile.revision });
      }
      const current = await status();
      const profiles = current.profiles.filter(item => item.appId === body.larkAppId);
      const text = profiles.length ? profiles.map(item =>
        `${item.name} · ${item.modelLabel}\n网关：${item.health.online ? '在线' : '离线'}；加速：${!item.controlAvailable ? '未接管' : item.enabled ? '开启' : '关闭'}；在途请求：${item.health.activeRequests ?? '未知'}`
      ).join('\n') : '此 Bot 尚未接入网关。';
      return reply(res, 200, { schemaVersion: 1, reply: { text } });
    } catch { return reply(res, 200, { schemaVersion: 1, reply: { text: '操作未完成，请在扩展插件中心检查启用范围与网关状态。' } }); }
  }
  if (req.url === '/status' && req.method === 'GET') return reply(res, 200, snapshot || {});
  reply(res, 404, { error: 'not_found' });
});
await poll();
const interval = setInterval(poll, 10000);
server.listen(18739, '127.0.0.1');
function stop() { clearInterval(interval); server.close(() => process.exit(0)); }
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
