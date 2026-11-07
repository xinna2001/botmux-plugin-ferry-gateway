import { RefreshCw, Download, LogIn, Radio, Check, ShieldCheck, Settings, X } from 'lucide';
const icons = { RefreshCw, Download, LogIn, Radio, Check, ShieldCheck, Settings, X };
let React;
export const runtime = value => { React = value; return value; };
export const h = (...args) => React.createElement(...args);
export function Icon({ name }) {
  const [tag, attrs, children] = icons[name] || Settings;
  const normalize = values => Object.fromEntries(Object.entries(values).map(([key, value]) => [key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), value]));
  return h(tag, { ...normalize(attrs), width: 16, height: 16, 'aria-hidden': true }, children.map(([child, props], index) => h(child, { ...normalize(props), key: index })));
}
export function Button({ icon, children, ...props }) {
  return h('button', { type: 'button', ...props, title: props.title || (typeof children === 'string' ? children : undefined) }, icon && h(Icon, { name: icon }), children);
}
export function Switch({ checked, disabled, label, onChange }) {
  return h('label', { className: 'pr-switch' }, h('input', { type: 'checkbox', role: 'switch', checked, disabled, 'aria-label': label, onChange: event => onChange(event.target.checked) }), h('span', { 'aria-hidden': true }));
}
export async function request(id, value) {
  const response = await fetch(`/api/plugins/${id}/settings`, {
    method: value ? 'PUT' : 'GET',
    headers: { 'content-type': 'application/json', 'x-botmux-csrf': document.querySelector('meta[name="botmux-csrf"]')?.content || '' },
    ...(value ? { body: JSON.stringify(value) } : {}),
  });
  const result = await response.json();
  if (!response.ok || result.ok === false) throw new Error(result.error || '请求失败');
  return result;
}
export const css = `
.pr-app{font:14px/1.55 var(--font);color:var(--fg);letter-spacing:0;max-width:980px}
.pr-app *{box-sizing:border-box;letter-spacing:0}.pr-app h2{font-size:17px;margin:0}.pr-app p{margin:4px 0}
.pr-section{padding:20px 0;border-bottom:1px solid var(--border-soft)}.pr-section:first-child{padding-top:0}
.pr-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 0}
.pr-row>div{min-width:0}.pr-muted{color:var(--muted);font-size:12px;overflow-wrap:anywhere}
.pr-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.pr-app button{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:34px;border:1px solid var(--border);border-radius:var(--radius-sm,6px);background:var(--surface);color:var(--fg);font:inherit;padding:6px 12px;cursor:pointer}
.pr-app button:hover{background:var(--surface-hover)}.pr-app button:disabled{opacity:.45;cursor:not-allowed}
.pr-app button:focus-visible,.pr-app input:focus-visible,.pr-app select:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.pr-app input:not([type=checkbox]),.pr-app select{font:inherit;min-height:34px;max-width:100%;color:var(--fg);background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm,6px);padding:6px 10px}
.pr-app input[type=password]{width:280px}.pr-app input[type=number]{width:110px}.pr-app select{min-width:170px}
.pr-pill{display:inline-block;font-size:12px;padding:3px 8px;border-radius:4px;background:var(--surface-muted);color:var(--muted);white-space:nowrap}
.pr-pill.passed{color:var(--success);background:var(--success-soft)}.pr-pill.denied{color:var(--danger);background:var(--danger-soft)}
.pr-checks{margin-top:12px}.pr-checks .pr-row{border-top:1px solid var(--border-soft)}
.pr-error{padding:12px;color:var(--danger);background:var(--danger-soft);border-left:3px solid var(--danger);overflow-wrap:anywhere}
.pr-switch{position:relative;width:40px;height:24px;flex:0 0 40px}.pr-switch input{position:absolute;opacity:0;width:100%;height:100%;z-index:1;margin:0}
.pr-switch span{position:absolute;inset:0;background:var(--border-strong);border-radius:20px}.pr-switch span:after{content:"";position:absolute;width:18px;height:18px;top:3px;left:3px;background:var(--surface);border-radius:50%}
.pr-switch input:checked+span{background:var(--accent)}.pr-switch input:checked+span:after{transform:translateX(16px);background:var(--on-accent)}.pr-switch input:disabled+span{opacity:.45}
.pr-app details{padding-top:16px}.pr-app summary{cursor:pointer;color:var(--muted)}.pr-app code{overflow-wrap:anywhere;font-size:12px}
.pr-confirm{padding:16px 0;border-block:1px solid var(--border);margin:16px 0}
.pr-confirm .pr-actions{margin-top:12px}
@media(max-width:600px){.pr-row{gap:10px;flex-wrap:wrap}.pr-actions{width:100%}.pr-app input[type=password]{width:100%}.pr-app select{width:100%}}
`;
