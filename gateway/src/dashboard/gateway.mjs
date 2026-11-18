import { runtime, h, Button, Switch, request } from './common.mjs';
import { gatewayTheme } from './gateway-theme.mjs';
import { GatewayPrerequisites } from './prerequisites.mjs';
import { GatewayScopeControls } from './scope.mjs';
import { mergeSnapshot, readState, announceStateChange, subscribeStateChange } from './state.mjs';
import { GatewayConnectionTools } from './connection-tools.mjs';

export function GatewayPanel({ react, onlyApp, onChanged, controlsOnly = false, snapshot, patch }) {
  const R = runtime(react);
  const [data, setData] = R.useState(null), [error, setError] = R.useState(''), [busy, setBusy] = R.useState(false);
  const bootstrapAttempts = R.useRef(new Set());
  const [refreshing, setRefreshing] = R.useState(false), [refreshMessage, setRefreshMessage] = R.useState('');
  const [reading, setReading] = R.useState(false);
  const incoming = patch === undefined ? snapshot : patch;
  R.useEffect(() => {
    if (incoming) setData(previous => !previous && incoming.scopeOnly ? previous : mergeSnapshot(previous, incoming));
  }, [incoming]);
  R.useEffect(() => subscribeStateChange(async () => {
    try { const state = await readState(); setData(previous => previous ? mergeSnapshot(previous, state) : previous); } catch {}
  }), []);
  const pending = R.useRef(false), epoch = R.useRef(0);
  const readPending = R.useRef(0), manualPending = R.useRef(0), readController = R.useRef(null);
  const queuedManual = R.useRef(false);
  const loginWindow = R.useRef(null);
  R.useEffect(() => {
    const url = data?.setup?.job?.loginUrl;
    if (url && loginWindow.current && !loginWindow.current.closed) {
      try { loginWindow.current.location.href = url; } catch {}
      loginWindow.current = null;
    }
  }, [data?.setup?.job?.loginUrl]);
  R.useEffect(() => {
    if (data?.setup?.job?.state === 'failed' && loginWindow.current) {
      try { loginWindow.current.close(); } catch {}
      loginWindow.current = null;
    }
  }, [data?.setup?.job?.state]);
  const load = async (force = false, manual = false) => {
    if ((pending.current && !force) || manualPending.current) return;
    if (!force && readPending.current) {
      if (manual) {
        queuedManual.current = true;
        setRefreshing(true); setRefreshMessage('正在读取最新状态…');
      }
      return;
    }
    const current = ++epoch.current;
    readPending.current = current;
    setReading(true);
    if (manual) {
      manualPending.current = current; setRefreshing(true); setRefreshMessage('正在读取最新状态…'); setError('');
    }
    const controller = new AbortController(); readController.current = controller;
    try {
      const value = await request('/api/plugins/gateway-acceleration/settings', 'GET', undefined,
        { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
      if (current === epoch.current) {
        setData(previous => mergeSnapshot(previous, value)); setError('');
        if (manual) setRefreshMessage(`刷新完成，已读取最新状态（${new Date().toLocaleTimeString('zh-CN', { hour12: false })}）`);
      }
    } catch (failure) {
      if (current === epoch.current) {
        setError(failure.name === 'TimeoutError' ? '读取状态超时，请重试' : failure.message);
        if (manual) setRefreshMessage('刷新失败；仍保留上次成功读取的状态，请重试');
      }
    } finally {
      if (readPending.current === current) { readPending.current = 0; setReading(false); }
      if (manual && manualPending.current === current) {
        manualPending.current = 0;
        setRefreshing(false);
      }
      if (readController.current === controller) readController.current = null;
      if (queuedManual.current && !readPending.current && !pending.current) {
        queuedManual.current = false;
        void load(false, true);
      }
    }
  };
  R.useEffect(() => {
    let mounted = true;
    const refresh = async () => {
      if (mounted && !document.hidden) await load();
    };
    void refresh();
    return () => {
      mounted = false; queuedManual.current = false; epoch.current++;
      readController.current?.abort();
    };
  }, []);
  const perform = async value => {
    if (pending.current) return;
    if (value.action === 'login') {
      loginWindow.current = window.open('about:blank', '_blank');
      if (loginWindow.current) {
        loginWindow.current.opener = null;
        if (loginWindow.current.document.body) loginWindow.current.document.body.textContent = '正在获取本人登录入口…';
      }
    }
    pending.current = true; epoch.current++;
    // A read or long preparation job must never make an ON switch impossible
    // to turn OFF. Retire the stale read without reviving its spinner later.
    const cancelledRefresh = !!manualPending.current;
    readController.current?.abort();
    manualPending.current = 0; setRefreshing(false);
    if (cancelledRefresh) setRefreshMessage('已取消旧刷新，正在提交操作…');
    setBusy(true); setError('');
    try {
      if (['forwarding', 'acceleration'].includes(value.action) && value.enabled) {
        const profile = data?.profiles.find(item => item.id === value.profileId);
        if (profile && !profile.nativePluginEnabled) {
          // These are separate host transactions: never request a scope write
          // from inside the lifecycle-locked settings adapter.
          await request(`/api/plugins/gateway-acceleration/bots/${encodeURIComponent(profile.appId)}`, 'PUT', { enabled: true });
        }
        // OFF deliberately returns a lightweight snapshot, whose profile
        // revision cannot include the model catalog. Never reuse that old
        // revision for ON, otherwise a real off/on cycle fails as "stale".
        const snapshot = await request('/api/plugins/gateway-acceleration/settings');
        const scoped = snapshot.profiles.find(item => item.id === value.profileId);
        if (!scoped?.nativePluginEnabled) throw new Error('宿主未确认插件启用，请刷新后重试');
        value = { ...value, revision: scoped.revision };
        setData(previous => mergeSnapshot(previous, snapshot));
      }
      if (value.action === 'install-compatible') {
        const prepared = await request('/api/plugins/gateway-acceleration/settings', 'PUT', { action: 'prepare-install' });
        value = { action: 'install', confirm: true, nonce: prepared.plan.nonce };
      }
      const result = await request('/api/plugins/gateway-acceleration/settings', 'PUT', value);
      if (result.snapshot || result.state) setData(previous => mergeSnapshot(previous, result.snapshot || result.state));
      else await load(true);
      if (cancelledRefresh) setRefreshMessage('操作已保存，开关状态已更新');
      onChanged?.();
      announceStateChange();
    } catch (failure) {
      if (value.action === 'login' && loginWindow.current) {
        try { loginWindow.current.close(); } catch {}
        loginWindow.current = null;
      }
      await load(true); setError(failure.message);
      if (cancelledRefresh) setRefreshMessage('操作未确认，请根据最新状态核对后重试');
    }
    finally { pending.current = false; setBusy(false); }
  };
  const toggle = (profile, enabled, action = 'acceleration') => perform({ action, profileId: profile.id, enabled, revision: profile.revision });
  const architecture = { codex: 'Codex', traex: 'TraeX' };
  const setup = data?.setup;
  const working = busy || refreshing || setup?.job?.state === 'running';
  const profiles = data?.profiles.filter(profile => (!onlyApp || profile.appId === onlyApp)
    && (!controlsOnly || profile.pluginEnabled === true)) || [];
  const sourceLabel = { configured: '指定安装', managed: '独立安装', existing: '既有安装', global: '全局安装' };
  const healthLabel = profile => ({ online: '网关在线', offline: '离线', unknown: '状态待核验', unconfigured: '未接管' }[
    profile.health?.state || (profile.health?.online ? 'online' : 'offline')]);
  R.useEffect(() => {
    if (controlsOnly || !setup || busy || setup.job
      || !['runtime', 'dependency', 'dependency-error'].includes(setup.phase)) return;
    const key = `${setup.phase}:${setup.version || ''}:${setup.authenticated === true}`;
    if (bootstrapAttempts.current.has(key)) return;
    bootstrapAttempts.current.add(key);
    void perform({ action: 'bootstrap', confirm: true });
  }, [setup?.phase, setup?.version, setup?.authenticated, setup?.job?.state, busy]);
  const preparationLabel = {
    runtime: '正在自动准备 Node.js 运行环境…',
    dependency: '正在自动准备网关依赖…',
    'dependency-error': '实际守护进程的登录依赖异常，正在尝试修复；无需反复登录。',
    login: '依赖已准备好，请完成本人字节内部登录。',
    'auth-error': '登录状态查询失败，未判定为未登录，请重试检查。',
    gateway: '本人登录已完成，可启动网关或重试检查。',
    'gateway-auth': '进程已启动，但实际网关认证尚未成功；尚不能开启新线路。',
    catalog: '实际网关正在获取模型目录，尚未就绪。',
    ready: '已就绪，开关可直接接入当前 Bot 模型。',
  }[setup?.phase] || '正在检查环境…';
  return h('div', { className: 'ext-gateways', 'data-gateway-panel': true },
    error && h('div', { className: 'ext-error', role: 'alert' }, error),
    busy && h('p', { className: 'ext-muted ext-small', role: 'status', 'data-control-pending': true },
      '正在核验并保存操作；确认返回前保留原状态…'),
    !controlsOnly && h('section', { className: 'ext-onboarding', 'data-gateway-onboarding': true, 'aria-label': '环境与字节内部登录' },
      h('div', { className: 'ext-gateway-head' },
        h('div', null, h('h3', null, '环境与字节内部登录'),
          h('p', { className: 'ext-muted ext-small', role: 'status' },
            setup?.job?.state === 'running' ? setup.job.progress || '正在准备，请稍候…' : preparationLabel)),
        h('span', { className: `ext-pill ${setup?.ready ? '' : 'off'}` }, setup?.ready ? '已就绪' : '未就绪')),
      h('div', { className: 'ext-setup-states', 'data-setup-states': true },
        h('p', null, '依赖：', !setup ? '检查中' : setup.installed && setup.runtime?.ready
          ? setup.serving?.dependencies?.ready === false ? '需要修复' : '已安装' : '待安装'),
        h('p', null, '本人登录：', !setup || setup.statusError ? '状态待核验'
          : setup.authenticated === true ? '已登录' : '未登录'),
        h('p', null, '网关：', setup?.ready ? '运行中 · 认证与模型目录正常'
          : setup?.serving?.online ? '进程在线 · 尚未通过可用性检查' : '未启动')),
      h('div', { className: 'ext-actions' },
        h(Button, { disabled: working, onClick: () => void perform({ action: 'bootstrap', confirm: true }) },
          setup?.installed ? '修复依赖' : '安装依赖'),
        h(Button, { disabled: working || !setup,
          onClick: () => void perform({ action: 'login', confirm: true }) },
          setup?.job?.operation === 'login' && setup.job.state === 'running' ? '等待登录完成…'
            : setup?.authenticated ? '重新登录' : '字节内部登录'),
        h(Button, { disabled: working || setup?.authenticated !== true,
          onClick: () => void perform({ action: 'start', confirm: true }) },
          setup?.serving?.online ? '检查网关' : '启动网关')),
      setup?.job?.loginUrl && h('a', { href: setup.job.loginUrl, target: '_blank', rel: 'noopener noreferrer' }, '继续字节内部登录'),
      setup?.job?.state === 'failed' && h('div', null,
        h('p', { className: 'ext-error', role: 'alert' }, setup.job.error),
        h('p', { className: 'ext-muted ext-small' }, '请根据上方状态重试对应操作，登录失败不等于需要重装。')),
      h('p', { className: 'ext-muted ext-small' },
        '插件启用后会自动安装所需依赖。首次使用请完成本人字节内部登录，登录成功后自动启动并检查网关。需要公司网络与本人访问权限。'),
      h('details', { className: 'ext-environment-details' },
        h('summary', null, '环境与版本详情'),
        h('p', { className: 'ext-muted ext-small' }, `Node.js：${setup?.runtime?.version || '待准备'}`),
        h('p', { className: 'ext-muted ext-small' },
          `控制依赖：${setup?.version ? `FERRY ${setup.version} · ${sourceLabel[setup.source] || '本地安装'}` : '待安装'}`),
        setup?.detectedVersion && h('p', { className: 'ext-muted ext-small' }, `本地发现版本：FERRY ${setup.detectedVersion}`),
        h('div', { 'data-running-versions': true }, profiles.filter(profile => profile.health?.online && profile.health?.version).map(profile =>
          h('p', { key: profile.id, className: 'ext-muted ext-small' }, `${profile.name} 当前进程：FERRY ${profile.health.version}`))))),
    h('p', { className: 'ext-muted ext-small', 'data-acceleration-notice': true },
      '转发与模型配置仍按话题保留。关闭加速会停止已接入 0.9 的排队尝试和定时重试，不打断已开始的回答；旧版本话题需要迁移。短暂失败最多追加重试 3 次（5/15/30 秒），手动取消不会被总开关清除。'),
    h('p', { className: 'ext-muted ext-small', 'data-official-warning': true },
      '官方目前不建议使用加速/超频，以免占用其他同学资源；只有明确打开总开关才为新话题启用加速，也不保证免排队。'),
    !data ? h('div', { className: 'ext-empty' }, '正在读取 Bot 状态…') :
      h('div', { className: 'ext-daily-view', 'data-gateway-daily': true },
        profiles.length === 0 && !controlsOnly && h('p', { className: 'ext-empty' }, '暂无 Bot。请先在 Botmux 中配置 Bot。'),
        profiles.map(profile => h('section', { className: 'ext-gateway', key: profile.id, 'aria-label': profile.name },
        h('div', { className: 'ext-gateway-head' },
          h('div', null, h('h3', null, profile.name),
            h('span', { className: 'ext-muted ext-small' }, `${architecture[profile.cliId] || profile.cliId || ''} · ${profile.modelLabel}`),
            h('p', { className: 'ext-muted ext-small' }, profile.pluginEnabled ? '插件已对此 Bot 启用' : '首次开启会为此 Bot 启用插件并接入当前模型')),
          h('span', { className: `ext-pill ${profile.health.online ? '' : 'off'}` }, healthLabel(profile))),
        profile.cliId === 'codex' && h('div', { className: 'ext-row', 'data-forwarding-status': profile.connection?.code || 'route' },
          h('div', null, h('div', { className: 'ext-bot-name' }, '新话题模型转发'),
            h('div', { className: 'ext-muted ext-small' }, profile.connection?.reason || '尚未核验此 Bot 的 FERRY 转发线路')),
          h(Switch, { checked: profile.connection?.enabled === true,
            disabled: busy || (!profile.connection?.enabled && (working || !!error || profile.canEnableForwarding !== true)),
            label: `${profile.name} 模型转发`, onChange: value => void toggle(profile, value, 'forwarding') })),
        (profile.cliId === 'traex' || (profile.cliId === 'codex' && profile.connection?.enabled)) && h('div', { className: 'ext-row', 'data-acceleration-control': true },
          h('div', null, h('div', { className: 'ext-bot-name' }, '同模型加速'),
            h('div', { className: 'ext-muted ext-small' }, profile.compatibility?.reason || (!profile.pluginEnabled ? '插件尚未对此 Bot 启用' : profile.autoModel ? '与自动模型切换互斥' : '现有网关已接入'))),
          h(Switch, { checked: profile.enabled === true,
            disabled: busy || (!profile.enabled && (working || !!error || profile.canEnableAcceleration !== true)),
            label: `${profile.name} 同模型加速`, onChange: value => void toggle(profile, value) })),
        !['codex', 'traex'].includes(profile.cliId) && h('p', { className: 'ext-muted ext-small' },
          '当前客户端未适配，不能开启转发或加速；不会修改此 Bot。')))),
    data && h(GatewayConnectionTools, { react, snapshot: data, profiles,
      onChanged: async () => { await load(true); announceStateChange(); } }),
    h('div', { className: 'ext-refresh-row' },
      h(Button, { className: 'ext-refresh', icon: refreshing ? 'LoaderCircle' : 'RefreshCw',
        'aria-busy': reading || refreshing, onClick: () => void load(false, true), disabled: busy || refreshing },
        refreshing ? '正在刷新…' : '刷新状态'),
      h('span', { className: 'ext-muted ext-small', role: 'status', 'aria-live': 'polite', 'data-refresh-feedback': true }, refreshMessage)));
}
export default function GatewayDashboard({ api }) {
  runtime(api.react);
  return h(GatewayManagement, { api });
}

export function GatewayManagement({ api, management, onReadinessChange }) {
  const R = runtime(api.react);
  const [ready, setReady] = R.useState(false), [advancedOpen, setAdvancedOpen] = R.useState(false);
  const [snapshot, setSnapshot] = R.useState(null), [scopeBusy, setScopeBusy] = R.useState(false), [scopeError, setScopeError] = R.useState('');
  const [panelPatch, setPanelPatch] = R.useState(null);
  const pendingScope = R.useRef(false);
  const acceptReady = R.useCallback(value => { setReady(value); onReadinessChange?.(value); }, [onReadinessChange]);
  const acceptSnapshot = R.useCallback(value => {
    setSnapshot(previous => mergeSnapshot(previous, value)); setPanelPatch(value);
  }, []);
  const changeScope = async (appId, enabled) => {
    if (pendingScope.current || !snapshot) return;
    pendingScope.current = true; setScopeBusy(true); setScopeError('');
    try {
      // Keep native host scope installed for old topics. Only add missing
      // authority on enable; disable updates new-topic defaults, not old routes.
      if (enabled) {
        const targets = appId === 'global' ? snapshot.profiles : snapshot.profiles.filter(p => p.appId === appId);
        for (const profile of targets.filter(profile => profile.nativePluginEnabled !== true)) {
          await request(`/api/plugins/gateway-acceleration/bots/${encodeURIComponent(profile.appId)}`,
            'PUT', { enabled: true });
        }
      }
      const value = await request('/api/plugins/gateway-acceleration/settings', 'PUT',
        { action: 'default-scope', appId, enabled });
      if (value.ok === false) throw new Error(value.error);
      if (!value.snapshot && !value.state) throw new Error('宿主没有返回已保存的启用状态');
      acceptSnapshot(value.snapshot || value.state);
      announceStateChange(); api.refreshManagement?.();
    } catch (error) { setScopeError(error.message); }
    finally { pendingScope.current = false; setScopeBusy(false); }
  };
  const scope = Array.isArray(snapshot?.profiles) ? { globalEnabled: snapshot.defaults?.globalEnabled === true,
    busy: scopeBusy, bots: snapshot.profiles.map(profile => ({ id: profile.appId, name: profile.name, enabled: profile.pluginEnabled })),
    onToggle: changeScope } : null;
  const info = management?.presentation;
  return h('div', { 'data-plugin-managed-layout': 'gateway-acceleration',
    'data-plugin-layout-version': typeof __FERRY_PLUGIN_VERSION__ === 'undefined' ? 'development' : __FERRY_PLUGIN_VERSION__ },
    h('style', null, gatewayTheme),
    h('div', { className: 'plugin-store-introduction' },
      h('div', { className: 'plugin-store-audience' }, h('span', null, info?.audience || '仅限字节内部使用')),
      h('p', null, '自动检测并安装 FERRY，完成字节内部登录后使用网关。')),
    h(GatewayPrerequisites, { api, onReadinessChange: acceptReady, onSnapshot: acceptSnapshot }),
    scopeError && h('p', { className: 'ext-error', role: 'alert' }, scopeError),
    scopeBusy && h('p', { className: 'plugin-muted', role: 'status', 'data-scope-pending': true }, '正在确认启用范围与实时加速开关…'),
    scope ? h(GatewayScopeControls, { react: api.react, scope, ready }) : h('p', null, '正在检查启用状态…'),
    snapshot?.profiles.filter(profile => profile.routingTransition).map(profile => {
      const transition = profile.routingTransition;
      const counts = transition.counts;
      return h('p', { key: `routing-${profile.appId}`, 'data-routing-transition': profile.appId,
        className: transition.phase === 'blocked' ? 'ext-error' : 'plugin-muted', role: 'status' },
        `${profile.name} · 旧话题${transition.mode === 'native' ? '退出网关' : '接入网关'}：${transition.message}`,
        counts && `（已核验 ${counts.verified}，待空闲 ${counts.waiting}，切换中 ${counts.switching}，待处理 ${counts.blocked}）`);
    }),
    h('details', { className: 'plugin-advanced', 'data-gateway-advanced': true,
      onToggle: event => setAdvancedOpen(event.currentTarget.open) },
      h('summary', null, '高级设置'),
      advancedOpen && h('div', { className: 'plugin-card-body ext-app', 'data-plugin-advanced-panel': 'gateway-acceleration' },
        h(GatewayPanel, { react: api.react, controlsOnly: true, snapshot, patch: panelPatch,
          onChanged: async () => {
            try { const state = await readState(api); acceptSnapshot(state); } catch {}
            api.refreshManagement?.();
          } }))));
}

export const management = { version: 1, placement: 'before-scope-controls', Component: GatewayPrerequisites };
export const managementLayout = { version: 1, placement: 'dialog-body', Component: GatewayManagement };
