import { runtime, h, Button, Switch, request } from './common.mjs';
import { gatewayTheme } from './gateway-theme.mjs';

export function GatewayPanel({ react, onlyApp }) {
  const R = runtime(react);
  const [data, setData] = R.useState(null), [error, setError] = R.useState(''), [busy, setBusy] = R.useState(false);
  const pending = R.useRef(false), epoch = R.useRef(0);
  const loginWindow = R.useRef(null);
  R.useEffect(() => {
    const url = data?.setup?.job?.loginUrl;
    if (url && loginWindow.current && !loginWindow.current.closed) {
      try { loginWindow.current.location.href = url; } catch {}
      loginWindow.current = null;
    }
  }, [data?.setup?.job?.loginUrl]);
  const load = async (force = false) => {
    if (pending.current && !force) return;
    const current = ++epoch.current;
    try {
      const value = await request('/api/plugins/gateway-acceleration/settings');
      if (current === epoch.current) { setData(value); setError(''); }
    } catch (failure) { if (current === epoch.current) setError(failure.message); }
  };
  R.useEffect(() => {
    let mounted = true;
    const refresh = async () => {
      if (mounted && !document.hidden) await load();
    };
    void refresh();
    const interval = setInterval(() => { void refresh(); }, 5000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      mounted = false; epoch.current++; clearInterval(interval);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);
  const perform = async value => {
    if (value.action === 'login') {
      loginWindow.current = window.open('about:blank', '_blank');
      if (loginWindow.current) {
        loginWindow.current.opener = null;
        if (loginWindow.current.document.body) loginWindow.current.document.body.textContent = '正在获取本人登录入口…';
      }
    }
    pending.current = true; epoch.current++;
    setBusy(true); setError('');
    try {
      if (value.action === 'install-compatible') {
        const prepared = await request('/api/plugins/gateway-acceleration/settings', 'PUT', { action: 'prepare-install' });
        value = { action: 'install', confirm: true, nonce: prepared.plan.nonce };
      }
      const result = await request('/api/plugins/gateway-acceleration/settings', 'PUT', value);
      if (result.snapshot) setData(result.snapshot);
      else await load(true);
    } catch (failure) { await load(true); setError(failure.message); }
    finally { pending.current = false; setBusy(false); }
  };
  const toggle = (profile, enabled, action = 'acceleration') => perform({ action, profileId: profile.id, enabled, revision: profile.revision });
  const architecture = { codex: 'Codex', traex: 'TraeX' };
  const setup = data?.setup;
  const working = busy || setup?.job?.state === 'running';
  const setupRow = (title, ready, detail, action, enabled = true) => h('div', { className: 'ext-row', key: title },
    h('div', null, h('strong', null, title), h('p', { className: 'ext-muted ext-small' }, detail)),
    ready ? h('span', { className: 'ext-pill' }, '已就绪')
      : h(Button, { disabled: working || !enabled, onClick: () => void perform({ action, confirm: true }) },
        action === 'login' ? '本人登录' : '一键补足'));
  return h('div', { className: 'ext-gateways', 'data-gateway-panel': true },
    error && h('div', { className: 'ext-error', role: 'alert' }, error),
    h('p', { className: 'ext-muted ext-small', 'data-acceleration-notice': true },
      '同模型加速仅支持已适配的 GPT 系列；其他系列不支持，开启时会报错。'),
    !data ? h('div', { className: 'ext-empty' }, '正在自动检查环境与网关状态…') :
      !data.runtime?.online ? h('section', { className: 'ext-setup', 'aria-label': '首次配置' },
        h('h3', null, '首次配置'),
        setupRow('运行环境', setup?.runtime?.ready, setup?.runtime?.version || '需要 Node.js 22+ 和 npm', 'runtime-install'),
        setupRow('依赖', setup?.compatible,
          setup?.compatible ? `复用 FERRY ${setup.version}` : `需要已核验的 FERRY ${setup?.requiredVersion || ''}；不会覆盖已有全局安装`,
          'install-compatible', setup?.runtime?.ready),
        setupRow('内部登录', setup?.authenticated, setup?.authenticated ? '复用本人的现有登录' : '请使用本人的内部账号授权',
          'login', setup?.runtime?.ready && setup?.installed),
        setup?.job?.loginUrl && h('a', { href: setup.job.loginUrl, target: '_blank', rel: 'noopener noreferrer' }, '打开本人登录页面'),
        setup?.job?.state === 'failed' && h('div', { className: 'ext-error', role: 'alert' }, setup.job.error),
        h(Button, { disabled: working || !setup?.runtime?.ready || !setup?.compatible || !setup?.authenticated,
          onClick: () => void perform({ action: 'initialize', confirm: true }) },
          working ? '正在准备…' : '完成配置')) :
      data.profiles.filter(profile => !onlyApp || profile.appId === onlyApp).map(profile => h('section', { className: 'ext-gateway', key: profile.id, 'aria-label': profile.name },
        h('div', { className: 'ext-gateway-head' },
          h('div', null, h('h3', null, profile.name), h('span', { className: 'ext-muted ext-small' }, `${architecture[profile.cliId] || profile.cliId || ''} · ${profile.modelLabel}`)),
          h('span', { className: `ext-pill ${profile.health.online ? '' : 'off'}` }, profile.health.online ? '网关在线' : '离线')),
        h('div', { className: 'ext-row ext-model-row' },
          h('div', null, h('div', { className: 'ext-bot-name' }, 'GPT 模型'),
            h('p', { className: 'ext-muted ext-small' }, profile.enabled ? '更换模型前先关闭同模型加速'
              : profile.catalogError || (profile.cliId === 'codex' ? '选择模型会接入 FERRY 转发；同模型加速单独开启' : '按 TraeX 的原生模型和上下文档位匹配'))),
          h('select', { className: 'ext-model-select', 'aria-label': `${profile.name} GPT 模型`,
            value: profile.selectedModelId || '', disabled: working || !profile.pluginEnabled || profile.automaticPoolEnabled || profile.enabled,
            onChange: event => void perform({ action: 'model', profileId: profile.id, modelId: event.target.value, revision: profile.revision }) },
          h('option', { value: '', disabled: true }, '请选择对应的 GPT 模型'),
          ...(profile.modelChoices || []).map(choice => h('option', { key: choice.id, value: choice.id, disabled: !choice.availableForEffort },
            `${choice.label}${choice.accelerationAvailable ? '' : ' · 仅转发'}${choice.availableForEffort ? '' : ' · 当前档位不支持'}`)))),
        profile.cliId === 'codex' && h('div', { className: 'ext-row', 'data-forwarding-status': profile.connection?.code || 'route' },
          h('div', null, h('div', { className: 'ext-bot-name' }, '模型转发'),
            h('div', { className: 'ext-muted ext-small' }, profile.connection?.reason || '尚未核验此 Bot 的 FERRY 转发线路')),
          h(Switch, { checked: profile.connection?.enabled === true,
            disabled: working || !profile.connection?.controlAvailable || (!profile.connection?.enabled && !profile.pluginEnabled),
            label: `${profile.name} 模型转发`, onChange: value => void toggle(profile, value, 'forwarding') })),
        h('div', { className: 'ext-row' },
          h('div', null, h('div', { className: 'ext-bot-name' }, '同模型加速'),
            h('div', { className: 'ext-muted ext-small' }, profile.compatibility?.reason || (!profile.pluginEnabled ? '插件尚未对此 Bot 启用' : profile.autoModel ? '与自动模型切换互斥' : '现有网关已接入'))),
          h(Switch, { checked: profile.enabled, disabled: working || !profile.controlAvailable || (!profile.enabled && (!profile.pluginEnabled || profile.compatibility?.eligible === false)),
            label: `${profile.name} 同模型加速`, onChange: value => void toggle(profile, value) })),
        h('p', { className: 'ext-muted ext-small' }, '新设置用于新会话；旧会话保留原 provider 和历史，不会因开关被中断。'))),
    h(Button, { icon: 'RefreshCw', onClick: () => void load(), disabled: working }, '刷新状态'));
}
export default function GatewayDashboard({ api }) {
  runtime(api.react);
  return h('div', { className: 'ext-app' }, h('style', null, gatewayTheme), h(GatewayPanel, { react: api.react }));
}
