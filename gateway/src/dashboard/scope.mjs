import { runtime, h, request } from './common.mjs';

// The plugin owns presentation, not authority. Every write uses the existing
// scope-checked host route; no settings-adapter transaction is nested here.
export function GatewayScopeControls({ react, scope: supplied, ready }) {
  const R = runtime(react);
  const [fallback, setFallback] = R.useState(null), [busy, setBusy] = R.useState(false), [error, setError] = R.useState('');
  const mounted = R.useRef(true), pending = R.useRef(false), epoch = R.useRef(0);
  const accept = value => {
    const plugin = value.plugins?.find(p => p.id === 'gateway-acceleration');
    if (!plugin) throw new Error('宿主未返回当前插件的启用范围');
    setFallback({ globalEnabled: value.globalPlugins?.includes(plugin.id) === true, globalPending: false,
      bots: (value.bots || []).map(b => ({ id: b.id, name: b.name,
        enabled: plugin.enabledByBot?.[b.id] === true || b.plugins?.includes(plugin.id) === true })) });
  };
  const load = async () => {
    const current = ++epoch.current;
    try {
      const value = await request('/api/plugins', 'GET', undefined, { signal: AbortSignal.timeout(15000) });
      if (mounted.current && current === epoch.current) { accept(value); setError(''); }
    } catch (failure) { if (mounted.current && current === epoch.current) setError(failure.message); }
  };
  R.useEffect(() => {
    mounted.current = true;
    if (supplied) return () => { mounted.current = false; epoch.current++; };
    void load();
    const refresh = () => { if (!document.hidden && !pending.current) void load(); };
    const timer = setInterval(refresh, 5000);
    window.addEventListener('focus', refresh);
    return () => { mounted.current = false; epoch.current++; clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [!!supplied]);
  const scope = supplied || fallback;
  const perform = async (id, enabled) => {
    if (!scope || pending.current || scope.busy || busy || (enabled && (!ready || error))) return;
    if (id !== 'global' && !scope.bots.some(b => b.id === id)) return;
    if (supplied) { supplied.onToggle(id, enabled); return; }
    pending.current = true; epoch.current++; setBusy(true); setError('');
    let writeError = '';
    try {
      const suffix = id === 'global' ? 'global' : `bots/${encodeURIComponent(id)}`;
      const value = await request(`/api/plugins/gateway-acceleration/${suffix}`, 'PUT', { enabled });
      if (mounted.current) accept(value);
    } catch (failure) {
      writeError = failure.message;
    } finally {
      pending.current = false;
      if (mounted.current) {
        setBusy(false); await load();
        if (mounted.current && writeError) setError(writeError);
      }
    }
  };
  const working = busy || scope?.busy || scope?.globalPending;
  const toggle = (id, label, checked) => h('label', { className: 'toggle-row plugin-enable-toggle' },
    h('input', { type: 'checkbox', role: 'switch', 'data-ferry-scope-toggle': id,
      'aria-label': label, checked, disabled: working || (!checked && (!ready || !!error)),
      onChange: event => void perform(id, event.target.checked) }),
    h('span', { className: 'switch', 'aria-hidden': true }), id === 'global' && h('span', null, label));
  return h('section', { className: 'plugin-enable-section', 'data-plugin-owned-scope': true, 'aria-label': '按 Bot 启用' },
    error && h('p', { className: 'ext-error', role: 'alert' }, error),
    h('div', { className: 'plugin-enable-head' },
      h('div', null, h('h3', null, '按 Bot 启用'),
        h('p', { className: 'plugin-muted' }, '关闭后停用新话题，并立即停止已接入 0.9 的排队任务加速与重试；已开始的回答不打断。旧版本话题需迁移后受此开关控制。')),
      scope && toggle('global', '为所有 Bot 启用', scope.globalEnabled)),
    !scope ? h('p', { className: 'plugin-enable-empty', role: 'status' }, error || '正在读取启用范围…')
      : scope.globalEnabled ? h('p', { className: 'plugin-enable-empty' }, `已对全部 ${scope.bots.length} 个 Bot 启用；关闭上方开关后可单独设置。`)
        : h('div', { className: 'plugin-enable-list' }, scope.bots.length
          ? scope.bots.map(bot => h('div', { className: 'plugin-enable-row', key: bot.id },
            h('div', null, h('strong', null, bot.name), h('p', { className: 'plugin-muted' },
              bot.enabled ? '新话题已启用 · 允许同模型加速' : '新话题已停用 · 已接入 0.9 的加速请求已暂停')),
            toggle(bot.id, `${bot.name} 插件启用`, bot.enabled)))
          : h('p', { className: 'plugin-enable-empty' }, '暂无已配置 Bot')));
}
