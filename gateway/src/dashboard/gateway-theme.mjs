export const gatewayTheme = `
.ext-app{color:var(--fg);background:transparent;font-family:var(--font);font-size:var(--fs-14,14px);line-height:var(--lh-body,1.55);letter-spacing:0;padding:4px 0;max-width:980px}
.ext-app *{box-sizing:border-box}
.ext-app h3,.ext-app p{margin:0}.ext-app h3{font-size:17px}
.ext-app button{display:inline-flex;gap:7px;align-items:center;justify-content:center;min-height:var(--button-height,32px);width:fit-content;border:1px solid var(--border);background:var(--surface);color:var(--fg);border-radius:var(--radius-sm);padding:7px 12px;font:inherit;cursor:pointer}
.ext-app button:hover{background:var(--surface-hover)}.ext-app button:disabled{opacity:.5;cursor:not-allowed}
.ext-app button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.ext-app .ext-muted{color:var(--muted)}.ext-app .ext-small{font-size:12px}
.ext-app .ext-gateways{display:grid;gap:24px}
.ext-app .ext-gateway{border-bottom:1px solid var(--border-soft);padding-bottom:20px;min-width:0}
.ext-app .ext-gateway-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
.ext-app .ext-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 0}
.ext-app .ext-row+.ext-row{border-top:1px solid var(--border-soft)}
.ext-app .ext-row>div,.ext-app .ext-gateway-head>div{min-width:0;overflow-wrap:anywhere}
.ext-app .ext-pill{font-size:12px;color:var(--success);background:var(--success-soft);padding:3px 8px;border-radius:var(--radius-sm);white-space:nowrap}
.ext-app .ext-pill.off{color:var(--muted);background:var(--surface-muted)}
.ext-app .ext-bot-name{font-weight:600}
.ext-app .ext-switch{position:relative;width:40px;height:24px;display:inline-block;flex:0 0 40px}
.ext-app .ext-switch input{position:absolute;opacity:0;width:100%;height:100%;margin:0;z-index:1;cursor:pointer}
.ext-app .ext-switch span{position:absolute;inset:0;background:var(--border-strong);border-radius:var(--radius-full)}
.ext-app .ext-switch span:after{content:"";position:absolute;top:3px;left:3px;width:18px;height:18px;background:var(--surface);border-radius:50%;transition:transform 120ms ease-out}
.ext-app .ext-switch input:checked+span{background:var(--accent)}
.ext-app .ext-switch input:checked+span:after{transform:translateX(16px);background:var(--on-accent)}
.ext-app .ext-switch input:disabled+span{opacity:.5}
.ext-app .ext-switch input:focus-visible+span{outline:2px solid var(--accent);outline-offset:2px}
.ext-app .ext-request{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) minmax(0,1fr);gap:10px;padding:10px 0;font-size:12px;border-top:1px solid var(--border-soft);color:var(--muted);overflow-wrap:anywhere}
.ext-app .ext-error{padding:12px 16px;color:var(--danger);background:var(--danger-soft);border-left:3px solid var(--danger);overflow-wrap:anywhere}
.ext-app .ext-empty{padding:32px 0;color:var(--muted)}
@media(max-width:600px){.ext-app .ext-row{gap:10px}.ext-app .ext-gateway-head{align-items:flex-start}.ext-app .ext-request{gap:6px}}
`;
