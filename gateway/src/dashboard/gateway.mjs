import { runtime, h, Button, Switch, request } from './common.mjs';
import { gatewayTheme } from './gateway-theme.mjs';

export function GatewayPanel({ react, onlyApp }) {
  const R = runtime(react);
  const [data, setData] = R.useState(null), [error, setError] = R.useState(''), [busy, setBusy] = R.useState(false);
  const load = async () => {
    try { setData(await request('/api/plugins/gateway-acceleration/settings')); setError(''); }
    catch (e) { setError(e.message); }
  };
  R.useEffect(() => {
    let mounted = true;
    const refresh = async () => {
      try { const value = await request('/api/plugins/gateway-acceleration/settings'); if (mounted) { setData(value); setError(''); } }
      catch (e) { if (mounted) setError(e.message); }
    };
    void refresh();
    const interval = setInterval(() => { if (!document.hidden) void refresh(); }, 10000);
    return () => { mounted = false; clearInterval(interval); };
  }, []);
  const toggle = async (profile, enabled, action = 'acceleration') => {
    setBusy(true); setError('');
    try {
      const result = await request('/api/plugins/gateway-acceleration/settings', 'PUT', {
        action, profileId: profile.id, enabled, revision: profile.revision,
      });
      setData(result.snapshot);
    } catch (e) { await load(); setError(e.message); }
    finally { setBusy(false); }
  };
  const phase = { queued: '排队', waiting: '等待响应', answering: '回答中', complete: '已结束', error: '请求失败', unknown: '未知' };
  const architecture = { codex: 'Codex', 'claude-code': 'Claude Code', traex: 'TraeX' };
  return h('div', { className: 'ext-gateways', 'data-gateway-panel': true },
    error && h('div', { className: 'ext-error', role: 'alert' }, error),
    h('p', { className: 'ext-muted ext-small', 'data-acceleration-notice': true },
      '同模型加速仅支持已适配的 GPT 系列；其他系列不支持，开启时会报错。'),
    !data ? h('div', { className: 'ext-empty' }, '正在读取网关状态…') :
      data.profiles.filter(p => !onlyApp || p.appId === onlyApp).map(profile => h('section', { className: 'ext-gateway', key: profile.id, 'aria-label': profile.name },
        h('div', { className: 'ext-gateway-head' },
          h('div', null, h('h3', null, profile.name), h('span', { className: 'ext-muted ext-small' }, `${architecture[profile.cliId] || profile.cliId || ''} · ${profile.modelLabel}`)),
          h('span', { className: `ext-pill ${profile.health.online ? '' : 'off'}` }, profile.health.online ? '网关在线' : '离线')),
        profile.cliId !== 'traex' && h('div', { className: 'ext-row', 'data-forwarding-status': profile.connection?.code || 'route' },
          h('div', null, h('div', { className: 'ext-bot-name' }, '模型转发'),
            h('div', { className: 'ext-muted ext-small' }, profile.connection?.reason || '尚未核验此 Bot 的 FERRY 转发线路')),
          h(Switch, { checked: profile.connection?.enabled === true,
            disabled: busy || !profile.connection?.controlAvailable || (!profile.connection?.enabled && !profile.pluginEnabled),
            label: `${profile.name} 模型转发`, onChange: value => void toggle(profile, value, 'forwarding') })),
        h('div', { className: 'ext-row' },
          h('div', null, h('div', { className: 'ext-bot-name' }, '同模型加速'),
            h('div', { className: 'ext-muted ext-small' }, profile.compatibility?.reason || (!profile.pluginEnabled ? '插件尚未对此 Bot 启用' : profile.autoModel ? '与自动模型切换互斥' : '现有网关已接入'))),
          h(Switch, { checked: profile.enabled, disabled: busy || !profile.controlAvailable || (!profile.enabled && (!profile.configured || !profile.pluginEnabled || profile.autoModel || profile.compatibility?.eligible === false)),
            label: `${profile.name} 同模型加速`, onChange: value => void toggle(profile, value) })),
        profile.requests.map(row => h('div', { className: 'ext-request', key: row.session },
          h('span', null, row.session),
          h('span', null, row.stale ? '历史记录' : phase[row.phase]),
          h('span', null, row.stale ? new Date(row.observedAt).toLocaleTimeString('zh-CN') :
            row.phase === 'queued' && row.position !== null ? `第 ${row.position} 位` : row.accelerated ? '已加速' : '普通通道'))))),
    h(Button, { icon: 'RefreshCw', onClick: () => void load(), disabled: busy }, '刷新状态'));
}
export default function GatewayDashboard({ api }) {
  runtime(api.react);
  return h('div', { className: 'ext-app' }, h('style', null, gatewayTheme), h(GatewayPanel, { react: api.react }));
}
