---
name: gateway-acceleration
description: Inspect configured local gateways, explain queue state, and manage same-model acceleration through the installed Botmux gateway plugin.
---

# Gateway Acceleration

Use `botmux gateway:status` for scope, runtime and same-model acceleration status.
If a host only discovers globally enabled commands, use the scope-checked entry:

```bash
node "$HOME/.botmux/plugins/gateway-acceleration/dist/bin/status.mjs"
```

Never globally enable the plugin just to make command discovery work.
Never print tokens, credential files, prompts or raw private runtime logs.

The native plugin page controls per-Bot activation. The plugin settings page
automatically checks runtime, dependency and personal login without a Bot chooser.
Missing dependencies require an explicit repair click. The adapter reuses a
compatible official `@ad/ferry` installation or installs its pinned version
privately; it does not redistribute upstream implementation or grant access.

Version 0.2.0 verifies FERRY 0.1.98 source identity before preparing a private
instrumented runtime. It never edits the upstream file. Unknown versions fail
closed. Tested clients are Codex 0.166.0 and TraeX 0.213.1 on macOS arm64 with
Botmux 3.58.0. Check compatibility before upgrades.

Discover architecture from each Bot's actual CLI. Codex has independent forwarding
and acceleration controls. Selecting a Ferry GPT model explicitly enables
forwarding but leaves acceleration off. TraeX has acceleration only, matching its
native model, context variant and effort against the Ferry capability catalog.
Only supported fixed GPT models may accelerate. Reject auto-model pools, unknown
wrappers, unsupported efforts or isolation modes; never silently substitute
models, lower effort, inflate context or disable isolation.

Turning acceleration off does not change the model or disable Codex forwarding.
Turning forwarding off while acceleration is on requires a separate explicit
acceleration-off action. A Ferry-only Codex model cannot launch a fresh native
session with forwarding off; ask the user to select a native model or re-enable
forwarding rather than silently choosing one.

The management service may recover its own configured runtime. It does not stop
legacy gateways or active inference. Never cancel active requests, rewrite
history, migrate provider or remove old launchers just to change a toggle.
Old sessions retain their recorded provider; unknown history identity fails
closed. Extra wrappers, remote/isolated modes and external app-server pools are
not automatically adopted.

Authorized `/gateway status|on|off` operates on the current Bot; mutations require
management permission. Routine UI omits request counters and history tables.
Acceleration still may queue and is not a promise of zero waiting or faster
service. A queue snapshot older than two minutes is historical, not a live rank.
