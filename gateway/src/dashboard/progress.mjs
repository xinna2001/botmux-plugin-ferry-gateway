export function UpdateProgress({ react: R, job }) {
  const h = R.createElement;
  const gradient = `ferry-update-${R.useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const percent = Number.isFinite(job?.percent) ? Math.max(0, Math.min(100, job.percent)) : null;
  const circumference = 2 * Math.PI * 20;
  return h('span', { className: 'dashboard-version-ring ferry-update-ring',
    role: 'progressbar', 'data-ferry-update-progress': true, 'aria-valuemin': 0, 'aria-valuemax': 100,
    ...(percent === null ? {} : { 'aria-valuenow': percent }),
    'aria-label': job?.progress || '正在更新 FERRY', title: '阶段进度按已完成的验证步骤计算，不按等待时间伪造进度' },
  h('svg', { viewBox: '0 0 44 44', width: 44, height: 44, 'aria-hidden': true },
    h('defs', null, h('linearGradient', { id: gradient, x1: '0%', y1: '100%', x2: '100%', y2: '0%' },
      h('stop', { offset: '0%', stopColor: 'var(--brand-accent-cyan,var(--accent))' }),
      h('stop', { offset: '55%', stopColor: 'var(--accent)' }),
      h('stop', { offset: '100%', stopColor: 'var(--brand-accent-pink,var(--accent))' }))),
    h('circle', { cx: 22, cy: 22, r: 20, fill: 'none', stroke: 'var(--border)', strokeWidth: 3 }),
    h('circle', { cx: 22, cy: 22, r: 20, fill: 'none', stroke: `url(#${gradient})`, strokeWidth: 3,
      strokeLinecap: 'round', className: percent === null ? 'ferry-update-indeterminate' : '',
      style: { strokeDasharray: circumference, strokeDashoffset: circumference * (1 - (percent === null ? 0.25 : percent / 100)),
        transform: 'rotate(-90deg)', transformOrigin: 'center' } })),
  h('span', { className: 'dvr-pct' }, percent === null ? '…' : `${Math.round(percent)}%`));
}
