import { runtime, h, Button, Icon, css } from '../shared/ui.mjs';
import { STEPS } from './steps.mjs';

const labels = { pending: '等待检查', running: '检查中', passed: '已就绪', warning: '已就绪', blocked: '待补足' };
export default function InstallationWizard({ api, onDone }) {
  const R = runtime(api.react);
  const [flow, setFlow] = R.useState(null), [busy, setBusy] = R.useState(''), [error, setError] = R.useState('');
  const [retry, setRetry] = R.useState(0);
  const mounted = R.useRef(true);
  R.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  R.useEffect(() => {
    let mounted = true;
    api.begin().then(value => { if (mounted) setFlow(value); }).catch(e => { if (mounted) setError(e.message); });
    return () => { mounted = false; };
  }, [retry]);
  R.useEffect(() => {
    if (!flow || flow.state !== 'checking' || busy) return;
    let mounted = true;
    const blocked = flow.steps.some(step => step.state === 'blocked');
    const timer = setTimeout(() => {
      api.advance(flow.id).then(value => { if (mounted) setFlow(value); }).catch(e => { if (mounted) setError(e.message); });
    }, blocked ? 2000 : 0);
    return () => { mounted = false; clearTimeout(timer); };
  }, [flow, busy]);
  async function repair(step) {
    setBusy(step); setError('');
    try {
      await api.repair(step, flow.id);
      const deadline = Date.now() + 6 * 60 * 1000;
      for (;;) {
        if (!mounted.current) return;
        if (Date.now() > deadline) throw new Error('操作仍未完成，请检查登录窗口后重试');
        const job = await api.job();
        if (job?.state !== 'running') {
          if (job?.state === 'failed') throw new Error(job.error || '补足未完成，请重试');
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
      if (mounted.current) setFlow(await api.advance(flow.id));
    } catch (e) { if (mounted.current) setError(e.message); }
    finally { if (mounted.current) setBusy(''); }
  }
  const steps = flow?.steps || STEPS.map(step => ({ ...step, state: 'running' }));
  return h('div', { className: 'pr-app install-wizard', 'data-installation-wizard': true },
    h('style', null, css + `
.install-wizard{max-width:680px;margin:auto}.install-wizard h2{font-size:20px;margin:0}.install-checks{list-style:none;margin:24px 0;padding:0}.install-check{display:flex;align-items:center;gap:14px;padding:22px 0;border-bottom:1px solid var(--border);min-height:94px}.install-check>svg{flex:0 0 22px;color:var(--muted)}.install-check.passed>svg{color:var(--success)}.install-check-body{flex:1;min-width:0;overflow-wrap:anywhere}.install-check-body h3{font-size:15px;margin:0 0 5px}.install-check-body p{font-size:12px;margin:0;color:var(--muted)}.install-check-status{font-size:12px;color:var(--muted);flex-shrink:0}.install-footer{display:flex;justify-content:flex-end;gap:12px;margin-top:24px}.install-check button{flex-shrink:0}@media(max-width:480px){.install-check{gap:10px;flex-wrap:wrap}.install-check-body{min-width:140px}.install-check button{margin-left:32px}}
`),
    h('h2', null, '安装 FERRY 网关'),
    h('p', { className: 'pr-muted' }, '仅限字节内部使用'),
    error && h('div', { className: 'pr-error', role: 'alert' }, error),
    h('ul', { className: 'install-checks', 'aria-label': '安装环境' }, steps.map(step =>
      h('li', { key: step.id, className: `install-check ${step.state}`, 'data-install-step': step.id },
        h(Icon, { name: step.state === 'passed' ? 'Check' : step.id === 'identity' ? 'LogIn' : 'ShieldCheck' }),
        h('div', { className: 'install-check-body' }, h('h3', null, step.label === 'FERRY 依赖' ? '依赖' : step.label),
          h('p', { 'aria-live': 'polite' }, busy === step.id ? step.id === 'identity' ? '等待浏览器登录完成' : '正在安装，请稍候' : step.message || labels[step.state])),
        step.state === 'blocked' ? h(Button, {
          icon: step.id === 'identity' ? 'LogIn' : 'Download', disabled: !!busy,
          onClick: () => void repair(step.id),
        }, busy === step.id ? '处理中' : step.id === 'identity' ? '登录' : '一键补足') :
          h('span', { className: 'install-check-status' }, labels[step.state])))),
    h('footer', { className: 'install-footer' },
      error && h(Button, { icon: 'RefreshCw', disabled: !!busy, onClick: () => { setError(''); setFlow(null); setRetry(value => value + 1); } }, '重试'),
      flow?.state === 'installed' ? h(Button, { icon: 'Check', onClick: onDone }, '进入插件管理') :
        h(Button, { icon: 'Download', disabled: busy !== '' || flow?.state !== 'ready', onClick: async () => {
          setBusy('install'); setError('');
          try { setFlow(await api.install(flow.id)); }
          catch (e) { setError(e.message); setFlow(value => ({ ...value, state: 'failed' })); }
          finally { setBusy(''); }
        } }, busy === 'install' ? '安装中' : '安装')));
}
