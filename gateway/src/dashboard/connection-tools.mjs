import { runtime, h, Button, request } from './common.mjs';

export function GatewayConnectionTools({ react, snapshot, profiles = [], onChanged }) {
  const R = runtime(react);
  const [port, setPort] = R.useState(''), [busy, setBusy] = R.useState(false);
  const [error, setError] = R.useState(''), [message, setMessage] = R.useState('');
  const requested = R.useRef(null), refreshed = R.useRef(null);
  const job = snapshot?.setup?.job;
  const running = job?.state === 'running';
  R.useEffect(() => {
    if (!requested.current || job?.operation !== 'change-port') return;
    if (job.state === 'failed') { setError(job.error || '端口未切换，原线路保持不变'); return; }
    if (job.state !== 'complete') return;
    if (snapshot.runtime?.ready && snapshot.runtime.port === requested.current) {
      setMessage(`新话题网关端口已实际切换至 ${requested.current}；旧话题保持原端口`);
      requested.current = null;
    } else if (refreshed.current !== job.id) {
      refreshed.current = job.id; void onChanged?.();
    }
  }, [job?.id, job?.state, snapshot?.runtime?.port, snapshot?.runtime?.ready]);
  const apply = async () => {
    if (busy || running) return;
    const value = Number(port);
    if (!Number.isInteger(value) || value < 1024 || value > 65535) {
      setError('端口必须在 1024–65535 之间'); return;
    }
    setBusy(true); setError(''); setMessage('');
    try {
      await request('/api/plugins/gateway-acceleration/settings', 'PUT',
        { action: 'port', port: value, revision: snapshot.configRevision, confirm: true });
      requested.current = value;
      setMessage('已受理，正在核验新网关；完成前不宣称端口已切换');
      await onChanged?.();
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  };
  const download = async profile => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const value = await request('/api/plugins/gateway-acceleration/settings', 'PUT',
        { action: 'connection-config', appId: profile.appId });
      if (typeof value.config?.content !== 'string' || !/^[a-z-]+\.toml$/.test(value.config.filename)) {
        throw new Error('未收到有效的转发配置，未下载');
      }
      const url = URL.createObjectURL(new Blob([value.config.content], { type: 'text/plain;charset=utf-8' }));
      const link = document.createElement('a'); link.href = url; link.download = value.config.filename; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage('已下载当前模型的本机转发配置，不含登录信息，也不启用自动加速');
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  };
  return h('details', { className: 'ext-environment-details', 'data-ferry-connection-tools': true },
    h('summary', null, '连接配置与端口'),
    h('p', { className: 'ext-muted ext-small', 'data-ferry-applied-port': true },
      snapshot?.runtime?.ready ? `当前新话题默认网关端口：${snapshot.runtime.port}` : '实际网关未就绪，尚不能导出或切换连接'),
    h('p', { className: 'ext-muted ext-small' },
      '切换只应用到新话题；旧话题原端口继续服务。不会关闭共享网关或改动模型。'),
    h('div', { className: 'ext-actions' },
      h('input', { type: 'number', min: 1024, max: 65535, inputMode: 'numeric', value: port,
        'aria-label': '新话题网关端口', 'data-ferry-port-input': true,
        onChange: event => setPort(event.target.value), disabled: busy || running }),
      h(Button, { 'data-ferry-port-apply': true, disabled: busy || running || !snapshot?.runtime?.ready,
        onClick: () => void apply() }, '核验并切换新话题端口')),
    h('div', { className: 'ext-actions' }, profiles.filter(p => ['codex','traex'].includes(p.cliId)).map(profile =>
      h(Button, { key: profile.appId, icon: 'Download', 'data-ferry-export': profile.appId,
        disabled: busy || !snapshot?.runtime?.ready, onClick: () => void download(profile) },
      `下载 ${profile.name} 转发配置`))),
    error && h('p', { className: 'ext-error', role: 'alert', 'data-ferry-connection-error': true }, error),
    message && h('p', { className: 'ext-muted ext-small', role: 'status', 'data-ferry-connection-feedback': true }, message));
}
