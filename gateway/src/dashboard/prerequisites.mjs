import { request } from './common.mjs';
import { mergeSnapshot, readState, announceStateChange, subscribeStateChange } from './state.mjs';
import { UpdateProgress } from './progress.mjs';

export function GatewayPrerequisites({ api, onReadinessChange, onSnapshot }) {
  const R = api.react, h = R.createElement;
  const [data, setData] = R.useState(null), [error, setError] = R.useState('');
  const [busy, setBusy] = R.useState(false), [action, setAction] = R.useState('');
  const currentData = R.useRef(null), mounted = R.useRef(true), reading = R.useRef(false);
  const lightReading = R.useRef(false), pending = R.useRef(false), popup = R.useRef(null);
  const epoch = R.useRef(0);
  const accept = value => {
    const next = mergeSnapshot(currentData.current, value);
    currentData.current = next; setData(next);
    // Forward the actual patch, not our locally merged view. A lightweight
    // scope response merged into an old unbound profile must not masquerade as
    // a fresh full snapshot and overwrite the parent's new binding/capability.
    onSnapshot?.(value);
    const setup = next?.setup;
    onReadinessChange?.(setup?.ready === true && setup.authenticated === true
      && setup.compatible === true && setup.runtime?.ready === true
      && next.runtime?.dependencies?.ready === true && setup.job?.state !== 'running');
    if (setup?.job?.loginUrl && popup.current && !popup.current.closed) {
      popup.current.location.href = setup.job.loginUrl; popup.current = null;
    }
    if (setup?.job?.state === 'failed' && popup.current) {
      popup.current.close(); popup.current = null;
    }
  };
  const load = async () => {
    if (!mounted.current || reading.current || pending.current) return;
    reading.current = true;
    const generation = ++epoch.current;
    try {
      const value = await (api.getSettings ? api.getSettings() :
        request('/api/plugins/gateway-acceleration/settings', 'GET', undefined, { signal: AbortSignal.timeout(15000) }));
      if (mounted.current && generation === epoch.current) { accept(value); setError(''); }
    } catch (failure) {
      if (mounted.current && generation === epoch.current) {
        onReadinessChange?.(false); setError(failure.message || '状态检查失败，请重试');
      }
    } finally { reading.current = false; }
  };
  const refreshLight = async () => {
    if (!mounted.current || document.hidden || lightReading.current || pending.current) return;
    lightReading.current = true;
    try {
      const before = currentData.current;
      const value = await readState(api);
      if (!mounted.current) return;
      accept(value);
      const oldJob = before?.setup?.job, job = value.setup?.job;
      const terminalJobChanged = job?.id && job.state !== 'running'
        && (oldJob?.id !== job.id || oldJob?.state !== job.state);
      const scopeChanged = (value.scopeRevision || 0) > (before?.scopeRevision || 0);
      if (terminalJobChanged || scopeChanged) {
        announceStateChange();
        void load();
      }
    } catch {} finally { lightReading.current = false; }
  };
  R.useEffect(() => {
    mounted.current = true; void load();
    const unsubscribe = subscribeStateChange(() => void refreshLight());
    const timer = setInterval(() => void refreshLight(), 1000);
    return () => {
      mounted.current = false; epoch.current++; clearInterval(timer); unsubscribe();
      onReadinessChange?.(false);
      if (popup.current) { popup.current.close(); popup.current = null; }
    };
  }, []);

  const perform = async (nextAction, extra = {}) => {
    if (pending.current) return;
    if (nextAction === 'login') {
      popup.current = window.open('about:blank', '_blank');
      if (popup.current) popup.current.opener = null;
    }
    pending.current = true; epoch.current++;
    setBusy(true); setAction(nextAction); setError('');
    // A version lookup never makes a usable installation or its scope unusable.
    if (nextAction !== 'check-update') onReadinessChange?.(false);
    try {
      const value = { action: nextAction, confirm: true, ...extra };
      const result = await (api.saveSettings ? api.saveSettings(value) :
        request('/api/plugins/gateway-acceleration/settings', 'PUT', value, { signal: AbortSignal.timeout(15000) }));
      if (result.ok === false) throw new Error(result.error || '操作未完成，请重试');
      if (result.snapshot || result.state) accept(result.snapshot || result.state);
      if (result.versionCheck) accept({ scopeOnly: true, versionCheck: result.versionCheck });
      if (result.job) accept({ scopeOnly: true, setup: { job: result.job } });
      if (!result.job && nextAction !== 'check-update' && !result.snapshot && !result.state) void load();
    } catch (failure) {
      if (mounted.current) {
        setError(failure.message);
        if (currentData.current) accept(currentData.current);
      }
      if (popup.current) { popup.current.close(); popup.current = null; }
    } finally {
      pending.current = false;
      if (mounted.current) { setBusy(false); setAction(''); void refreshLight(); }
    }
  };
  const setup = data?.setup, job = setup?.job;
  const preparing = busy || job?.state === 'running';
  const check = data?.versionCheck;
  const latest = check?.result || check?.previous;
  const checking = check?.state === 'checking' || (busy && action === 'check-update');
  const updating = job?.operation === 'update-latest' && job.state === 'running'
    || (busy && action === 'update-latest');
  const currentVersion = data?.runtime?.upstreamVersion || setup?.version || setup?.detectedVersion;
  const installed = setup?.installed === true || !!setup?.detectedVersion;
  const authenticated = setup?.authenticated === true;
  const failed = job?.state === 'failed';
  const actuallyInstalling = preparing && /正在安装|正在下载/.test(job?.progress || '');
  const installStatus = !setup || !setup.runtime ? '正在检查' : installed ? `已安装 · v${currentVersion}` :
    actuallyInstalling ? '安装中' : preparing ? '正在检查' : error || setup.statusError ? '检查失败' : failed ? '安装未完成' : '未安装';
  const loginStatus = job?.state === 'running' && job.operation === 'login' ? '登录中' :
    authenticated ? '已登录' : !setup || setup.authenticated === undefined ? '检查中' :
      setup.authenticated === false ? '未登录' : '检查失败';
  const note = error || setup?.statusError || (job?.state === 'running' ? job.progress || '正在准备，请稍候' :
    failed ? job.error : !setup || !setup.runtime ? '正在检查环境与登录状态…' :
      setup.ready ? '前置条件已完成，可以开启网关' :
        !installed ? 'FERRY 尚未安装，请安装依赖' : !authenticated ? '请完成本人字节内部登录' : '登录已完成，正在核验网关');
  const upToDate = latest && latest.latestVersion === currentVersion;
  const canUpdate = installed && latest?.supported === true && !!latest.integrity && !upToDate;
  const versionNote = checking ? '仅查询 FERRY 最新版本，不下载、不安装、不切换网关。' :
    check?.state === 'failed' ? check.error :
      latest ? `最新版本：FERRY ${latest.latestVersion}${upToDate ? ' · 已是最新版' :
        latest.supported ? '' : ' · 本插件尚未验证兼容性，暂不能更新'}（${new Date(latest.checkedAt).toLocaleTimeString('zh-CN', { hour12: false })} 查询）` :
        '尚未检查 FERRY 最新版本。检查与更新是两个独立操作。';
  return h('section', { 'aria-label': 'FERRY 安装与登录',
    ...(job?.state === 'running' ? { 'data-ferry-job-running': true } : {}) },
  h('div', { className: 'plugin-prerequisite-row' },
    h('div', null, h('strong', null, 'FERRY 网关'), h('span', {
      className: `plugin-status ${installed ? 'plugin-status-ok' : 'plugin-status-idle'}`, 'data-ferry-install-status': true }, installStatus)),
    h('div', { className: 'ferry-update-actions' },
      !installed && h('button', { type: 'button', className: 'btn-link', disabled: preparing || !setup?.runtime,
        'data-ferry-install': true, onClick: () => void perform('bootstrap') }, !setup?.runtime ? '正在检查' : '安装依赖'),
      h('button', { type: 'button', className: 'btn-link', disabled: checking || updating,
        'data-ferry-retry': true, onClick: () => void perform('check-update') }, checking ? '正在检查更新' : '检查更新'),
      (latest || updating) && h('button', { type: 'button',
        className: `btn-link ferry-update-button${updating ? ' is-updating' : ''}`,
        'data-ferry-update-latest': true, disabled: updating || checking || !canUpdate,
        'aria-label': updating ? '正在更新 FERRY' : '更新到最新版',
        onClick: () => void perform('update-latest', { version: latest.latestVersion }) },
        updating ? h(UpdateProgress, { react: R, job }) : upToDate ? '已是最新版' : '更新到最新版'))),
  h('p', { className: 'ferry-latest-version', 'data-ferry-latest-version': true,
    role: check?.state === 'failed' ? 'alert' : 'status', 'aria-live': 'polite' }, versionNote),
  h('div', { className: 'plugin-prerequisite-row' },
    h('div', null, h('strong', null, '字节内部登录'), h('span', {
      className: `plugin-status ${authenticated ? 'plugin-status-ok' : 'plugin-status-idle'}`, 'data-ferry-auth-status': true }, loginStatus)),
    h('button', { type: 'button', className: authenticated ? 'btn-link' : 'btn-link primary',
      'data-ferry-login': true, disabled: preparing || !installed, onClick: () => void perform('login'),
      'aria-label': `字节内部登录 · ${loginStatus}` }, authenticated ? '重新登录' : '字节内部登录')),
  error && h('button', { type: 'button', className: 'btn-link', disabled: preparing,
    onClick: () => void perform('refresh') }, '重新检查'),
  job?.loginUrl && h('a', { href: job.loginUrl, target: '_blank', rel: 'noopener noreferrer', className: 'btn-link' }, '打开本人登录页面'),
  h('p', { className: 'plugin-prerequisite-note', role: error || failed ? 'alert' : 'status' }, note),
  updating && h('p', { className: 'plugin-prerequisite-note', role: 'status' },
    `${job?.completedSteps || 0}/${job?.totalSteps || 5} 项验证已完成；圆圈显示阶段进度，旧话题网关保持运行。`));
}
