export const gatewayTheme = `
[data-plugin-managed-layout] > section[aria-label="FERRY 安装与登录"]{padding:0 24px 12px}
[data-plugin-managed-layout] .plugin-prerequisite-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 0}
[data-plugin-managed-layout] .plugin-prerequisite-row>div{display:flex;align-items:center;gap:10px;min-width:0;flex-wrap:wrap}
[data-plugin-managed-layout] .plugin-prerequisite-note{margin:4px 0 0;color:var(--muted,#6d7971);font-size:12px}
[data-plugin-managed-layout] .plugin-enable-section{padding:18px 24px 16px}
[data-plugin-managed-layout] .plugin-enable-head{display:flex;align-items:center;justify-content:space-between;gap:16px}
[data-plugin-managed-layout] .plugin-enable-head h3{margin:0;font-size:16px}
[data-plugin-managed-layout] .plugin-enable-head p{margin:4px 0 0;font-size:12px}
[data-plugin-managed-layout] .plugin-enable-list{margin-top:16px;max-height:none;overflow:visible}
[data-plugin-managed-layout] .plugin-enable-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 20px}
[data-plugin-managed-layout] .plugin-enable-row+.plugin-enable-row{border-top:1px solid var(--border-soft,#edf1ee)}
[data-plugin-managed-layout] .plugin-enable-row p{margin:4px 0 0;font-size:12px}
[data-plugin-managed-layout] .plugin-enable-toggle{display:flex;align-items:center;justify-content:flex-end;gap:10px;flex:none;width:auto;margin:0}
[data-plugin-managed-layout] .plugin-enable-toggle{position:relative;min-width:40px;min-height:24px}
[data-plugin-managed-layout] .plugin-enable-toggle input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;z-index:2;cursor:pointer;pointer-events:auto}
[data-plugin-managed-layout] .plugin-enable-toggle .switch{pointer-events:none}
[data-plugin-managed-layout] .ferry-update-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
[data-plugin-managed-layout] .ferry-latest-version{font-size:12px;color:var(--muted);margin-top:4px}
[data-plugin-managed-layout] .ferry-update-ring{position:relative;display:inline-flex;width:44px;height:44px;align-items:center;justify-content:center;flex:none}
[data-plugin-managed-layout] .ferry-update-ring .dvr-pct{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:11px;color:var(--fg)}
[data-plugin-managed-layout] .ferry-update-button.is-updating{border:0;background:transparent;padding:0;opacity:1}
[data-plugin-managed-layout] .ferry-update-indeterminate{animation:ferry-update-spin 1.2s linear infinite}
@keyframes ferry-update-spin{to{transform:rotate(270deg)}}
@media(prefers-reduced-motion:reduce){[data-plugin-managed-layout] .ferry-update-indeterminate{animation:none}}
@media(max-width:600px){[data-plugin-managed-layout] .plugin-enable-head{align-items:flex-start;flex-wrap:wrap}[data-plugin-managed-layout] .plugin-enable-row{padding:14px 16px}}
.ext-app{color:var(--fg,#202824);background:transparent;font-family:var(--font,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif);font-size:var(--fs-14,14px);line-height:var(--lh-body,1.55);letter-spacing:0;padding:4px 0;max-width:980px}
.ext-app *{box-sizing:border-box}
.ext-app h3,.ext-app p{margin:0}.ext-app h3{font-size:17px}
.ext-app button{display:inline-flex;gap:7px;align-items:center;justify-content:center;min-height:var(--button-height,32px);width:fit-content;border:1px solid var(--border,#dce4df);background:var(--surface,#fff);color:var(--fg,#202824);border-radius:var(--radius-sm,6px);padding:7px 12px;font:inherit;cursor:pointer}
.ext-app button:hover{background:var(--surface-hover,#f0f5f2)}.ext-app button:disabled{opacity:.5;cursor:not-allowed}
.ext-app button:focus-visible{outline:2px solid var(--accent,#198557);outline-offset:2px}
.ext-app .ext-muted{color:var(--muted,#6d7971)}.ext-app .ext-small{font-size:12px}
.ext-app .ext-gateways{display:grid;gap:24px}
.ext-app .ext-onboarding{display:grid;gap:12px;border:1px solid var(--border,#dce4df);border-radius:8px;padding:18px}
.ext-app .ext-environment-details{font-size:12px;overflow-wrap:anywhere}
.ext-app .ext-environment-details summary{cursor:pointer;margin-bottom:8px}
.ext-app .ext-environment-details p{padding:3px 0}
.ext-app .ext-view-toolbar{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
.ext-app .ext-view-toolbar>p{flex:1;min-width:200px}
.ext-app .ext-view-toolbar>button{flex-shrink:0}
.ext-app .ext-daily-view,.ext-app .ext-setup-view{display:grid;gap:24px}
.ext-app .ext-refresh-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.ext-app .ext-refresh[aria-busy="true"] svg{animation:ext-refresh-spin 1s linear infinite}
@keyframes ext-refresh-spin{to{transform:rotate(360deg)}}
.ext-app .ext-runtime-versions{display:grid;gap:6px;padding:16px 0;border-top:1px solid var(--border-soft,#edf1ee);overflow-wrap:anywhere}
.ext-app .ext-gateway{border-bottom:1px solid var(--border-soft,#edf1ee);padding-bottom:20px;min-width:0}
.ext-app .ext-gateway-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
.ext-app .ext-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 0}
.ext-app .ext-row+.ext-row{border-top:1px solid var(--border-soft,#edf1ee)}
.ext-app .ext-row>div,.ext-app .ext-gateway-head>div{min-width:0;overflow-wrap:anywhere}
.ext-app .ext-pill{font-size:12px;color:var(--success,#197548);background:var(--success-soft,#eaf5ee);padding:3px 8px;border-radius:var(--radius-sm,6px);white-space:nowrap}
.ext-app .ext-pill.off{color:var(--muted,#6d7971);background:var(--surface-muted,#f1f3f2)}
.ext-app .ext-bot-name{font-weight:600}
.ext-app .ext-switch{position:relative;width:40px;height:24px;display:inline-block;flex:0 0 40px}
.ext-app .ext-switch input{position:absolute;inset:0;opacity:0;width:100%;height:100%;margin:0;z-index:2;cursor:pointer;pointer-events:auto}
.ext-app .ext-switch span{position:absolute;inset:0;pointer-events:none;background:var(--border-strong,#c5cec8);border-radius:var(--radius-full,999px)}
.ext-app .ext-switch span:after{content:"";position:absolute;top:3px;left:3px;width:18px;height:18px;background:var(--surface,#fff);border-radius:50%;transition:transform 120ms ease-out}
.ext-app .ext-switch input:checked+span{background:var(--accent,#198557)}
.ext-app .ext-switch input:checked+span:after{transform:translateX(16px);background:var(--on-accent,#fff)}
.ext-app .ext-switch input:disabled+span{opacity:.5}
.ext-app .ext-switch input:focus-visible+span{outline:2px solid var(--accent,#198557);outline-offset:2px}
.ext-app .ext-request{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) minmax(0,1fr);gap:10px;padding:10px 0;font-size:12px;border-top:1px solid var(--border-soft);color:var(--muted);overflow-wrap:anywhere}
.ext-app .ext-error{padding:12px 16px;color:var(--danger,#872626);background:var(--danger-soft,#fff0ef);border-left:3px solid var(--danger,#872626);overflow-wrap:anywhere}
.ext-app .ext-empty{padding:32px 0;color:var(--muted,#6d7971)}
.ext-app .ext-setup{max-width:720px}
@media(prefers-reduced-motion:reduce){.ext-app .ext-refresh[aria-busy="true"] svg{animation:none}}
@media(max-width:600px){.ext-app .ext-row{gap:10px}.ext-app .ext-gateway-head{align-items:flex-start}.ext-app .ext-request{gap:6px}}
`;
