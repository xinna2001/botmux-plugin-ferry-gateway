import { Puzzle, Search, RefreshCw, Download, X, Check, Settings, ArrowLeft, ExternalLink, Trash2, Radio, Zap, Globe, FlaskConical, LoaderCircle } from 'lucide';
const icons = { Puzzle, Search, RefreshCw, Download, X, Check, Settings, ArrowLeft, ExternalLink, Trash2, Radio, Zap, Globe, FlaskConical, LoaderCircle };
let React;
export function runtime(value) { React = value; return value; }
export function h(...args) { return React.createElement(...args); }
export function Icon({ name, size = 18 }) {
  const [tag, attrs, children] = icons[name] || Puzzle;
  const props = Object.fromEntries(Object.entries(attrs).map(([key, value]) => [key.replace(/-([a-z])/g, (_, s) => s.toUpperCase()), value]));
  return h(tag, { ...props, width: size, height: size, 'aria-hidden': true }, children.map(([child, values], index) =>
    h(child, { ...Object.fromEntries(Object.entries(values).map(([key, value]) => [key.replace(/-([a-z])/g, (_, s) => s.toUpperCase()), value])), key: index })));
}
export function Button({ icon, children, title, ...props }) {
  return h('button', { type: 'button', title: title || (typeof children === 'string' ? children : undefined), ...props },
    icon && h(Icon, { name: icon }), children);
}
export function Switch({ checked, onChange, disabled, label }) {
  return h('label', { className: 'ext-switch' },
    h('input', { type: 'checkbox', role: 'switch', checked, disabled, onChange: e => onChange(e.target.checked), 'aria-label': label }),
    h('span', { 'aria-hidden': true }));
}
export async function request(path, method = 'GET', value) {
  const csrf = document.querySelector('meta[name="botmux-csrf"]')?.content;
  const response = await fetch(path, {
    method, headers: { 'content-type': 'application/json', ...(csrf ? { 'x-botmux-csrf': csrf } : {}) },
    ...(value !== undefined ? { body: JSON.stringify(value) } : {}),
  });
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
export function Modal({ title, children, onClose }) {
  const ref = React.useRef(null);
  React.useEffect(() => {
    const previous = document.activeElement;
    const dialog = ref.current;
    dialog?.showModal();
    dialog?.focus();
    const listener = event => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab') {
        const nodes = [...dialog.querySelectorAll('button:not(:disabled),input:not(:disabled),a[href],select:not(:disabled),[tabindex="0"]')];
        if (!nodes.length) return event.preventDefault();
        const index = nodes.indexOf(document.activeElement);
        if (event.shiftKey && index <= 0) { event.preventDefault(); nodes.at(-1).focus(); }
        else if (!event.shiftKey && (index < 0 || index === nodes.length - 1)) { event.preventDefault(); nodes[0].focus(); }
      }
    };
    document.addEventListener('keydown', listener);
    return () => { document.removeEventListener('keydown', listener); dialog?.close(); previous?.focus?.(); };
  }, []);
  return h('dialog', { className: 'ext-dialog', 'aria-label': title, tabIndex: -1, ref,
    onCancel: event => { event.preventDefault(); onClose(); } },
      h('header', { className: 'ext-dialog-head' }, h('h2', null, title),
        h(Button, { icon: 'X', onClick: onClose, title: '关闭', 'aria-label': '关闭' })),
      children);
}
export const css = `
.ext-app{color:#202824;background:#fff;font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:0;min-height:420px;border-top:1px solid #e2e7e4;padding:22px 0;--ext-green:#16794d;--ext-border:#dce4df}
.ext-app *{box-sizing:border-box}.ext-app button,.ext-app input,.ext-app select{font:inherit;letter-spacing:0}
.ext-app button,.ext-app a.ext-btn{display:inline-flex;gap:7px;align-items:center;justify-content:center;min-height:36px;border:1px solid var(--ext-border);background:#fff;color:#29352e;border-radius:6px;padding:7px 12px;cursor:pointer;text-decoration:none;white-space:normal}
.ext-app button:hover{background:#f0f5f2}.ext-app button:disabled{opacity:.5;cursor:not-allowed}.ext-app button.primary{background:var(--ext-green);border-color:var(--ext-green);color:#fff}.ext-app button.danger{color:#b13737}.ext-app button:focus-visible,.ext-app input:focus-visible,.ext-app select:focus-visible,.ext-app a:focus-visible{outline:3px solid #80b69b;outline-offset:2px}
.ext-app label{color:inherit}.ext-app .ext-search input{background:#fff!important;color:#202824!important;padding:7px 12px 7px 38px!important;border:1px solid #dce4df!important;border-radius:6px!important}.ext-app select{background:#fff!important;color:#29352e!important;border:1px solid #dce4df!important;border-radius:6px!important}
.ext-app h2,.ext-app h3,.ext-app p{margin:0}.ext-app h2{font-size:20px}.ext-app h3{font-size:16px}.ext-app a{color:#186951}.ext-muted{color:#6d7971}.ext-small{font-size:12px}
.ext-toolbar{display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-bottom:20px;padding:0 2px}
.ext-tabs{display:flex;gap:4px}.ext-tabs button{border-color:transparent;background:transparent}.ext-tabs button.active{color:#126944;background:#e8f3ed;font-weight:600}
.ext-search{position:relative;flex:1;min-width:160px;max-width:380px}.ext-search svg{position:absolute;left:11px;top:11px;color:#758079}.ext-search input{height:40px;width:100%;border:1px solid var(--ext-border);border-radius:6px;padding:7px 12px 7px 38px;background:#fff;color:#202824}
.ext-toolbar select{height:40px;border:1px solid var(--ext-border);border-radius:6px;padding:7px;background:#fff;color:#29352e;max-width:100%}
.ext-summary{display:flex;justify-content:space-between;gap:12px;margin:0 2px 15px;flex-wrap:wrap}.ext-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,280px),1fr));gap:14px}
.ext-tile{border:1px solid var(--ext-border);border-radius:8px;padding:20px;display:flex;flex-direction:column;min-height:242px;background:#fff;min-width:0}
.ext-tile-head{display:flex;align-items:center;gap:12px;margin-bottom:12px}.ext-logo{display:grid;place-items:center;width:44px;height:44px;border-radius:8px;background:#e4f2eb;color:#17734b;flex-shrink:0}.ext-logo.blue{background:#e8f0fb;color:#3164ad}.ext-logo.amber{background:#fff4d6;color:#8b6913}
.ext-tile-description{color:#66726b;font-size:13px;min-height:42px;margin-bottom:12px!important;overflow-wrap:anywhere}.ext-tags{display:flex;flex-wrap:wrap;gap:6px}.ext-tag{font-size:11px;padding:2px 6px;border-radius:4px;background:#f1f4f2;color:#5c6860}
.ext-tile-footer{display:flex;gap:8px;justify-content:space-between;align-items:center;margin-top:auto;padding-top:18px}.ext-state{font-size:12px;color:#147443;display:flex;align-items:center;gap:5px}
.ext-error{padding:10px 13px;background:#fff0ef;border-left:3px solid #ba4545;color:#872626;margin-bottom:14px;overflow-wrap:anywhere}.ext-notice{padding:10px 13px;background:#f5f8f6;color:#59665d;margin-bottom:14px}
.ext-empty{padding:54px 20px;text-align:center;color:#69756d}.ext-overlay{position:fixed;inset:0;z-index:10000;background:rgba(13,22,17,.3);display:flex;align-items:center;justify-content:center;padding:20px}
.ext-dialog{background:white;color:#202824;width:680px;max-width:calc(100vw - 40px);max-height:90dvh;overflow:auto;border:0;border-radius:8px;box-shadow:0 18px 64px #0003;padding:24px;outline:none;margin:auto;position:fixed;inset:0}.ext-dialog::backdrop{background:rgba(13,22,17,.4)}
.ext-dialog-head{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:20px}.ext-dialog-head h2{overflow-wrap:anywhere}.ext-dialog-head button{width:36px;padding:7px;flex-shrink:0}
.ext-detail-brand{display:flex;gap:14px;align-items:center;margin-bottom:20px}.ext-detail-brand .ext-logo{width:58px;height:58px}.ext-detail-brand p{overflow-wrap:anywhere}.ext-section{border-top:1px solid var(--ext-border);margin-top:20px;padding-top:18px}.ext-section h3{margin-bottom:12px}
.ext-row{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:11px 0}.ext-row+.ext-row{border-top:1px solid #edf1ee}.ext-row label{flex:1}.ext-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:20px}
.ext-switch{position:relative;width:40px;height:24px;display:inline-block;flex:0 0 40px!important}.ext-switch input{position:absolute;opacity:0;width:100%;height:100%;margin:0;z-index:1;cursor:pointer}.ext-switch span{position:absolute;inset:0;background:#c5cec8;border-radius:20px}.ext-switch span:after{content:"";position:absolute;top:3px;left:3px;width:18px;height:18px;background:#fff;border-radius:50%;transition:transform .12s}.ext-switch input:checked+span{background:#198557}.ext-switch input:checked+span:after{transform:translateX(16px)}.ext-switch input:disabled+span{opacity:.5}.ext-switch input:focus-visible+span{outline:3px solid #80b69b;outline-offset:2px}
.ext-bot-list{max-height:220px;overflow:auto}.ext-bot-name{font-weight:500}.ext-pill{font-size:12px;color:#197548;background:#eaf5ee;padding:2px 7px;border-radius:4px}.ext-pill.off{background:#f1f3f2;color:#707970}
.ext-data{display:grid;grid-template-columns:120px 1fr;gap:9px 16px;margin:16px 0;font-size:13px}.ext-data dt{color:#738076}.ext-data dd{margin:0;overflow-wrap:anywhere}
.ext-gateways{display:grid;gap:22px}.ext-gateway{border-top:1px solid #e3e9e5;padding-top:16px}.ext-gateway:first-child{border-top:0;padding-top:0}.ext-gateway-head{display:flex;justify-content:space-between;align-items:center;gap:12px}.ext-request{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;font-size:12px;padding:9px 0;border-top:1px solid #eef1ef;color:#647068}.ext-live{color:#167349}.ext-spinner{animation:ext-spin 1s linear infinite}@keyframes ext-spin{to{transform:rotate(360deg)}}
@media(max-width:600px){.ext-app{padding:15px 0}.ext-toolbar{gap:10px}.ext-search{min-width:100%;max-width:none;order:2}.ext-grid{grid-template-columns:1fr}.ext-tile{min-height:220px}.ext-overlay{padding:10px}.ext-dialog{padding:18px;max-height:94vh}.ext-data{grid-template-columns:82px 1fr;gap:8px}.ext-tabs button{padding:7px 10px}.ext-row{gap:10px}.ext-request{gap:6px}}
`;
