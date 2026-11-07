---
name: gateway-acceleration
description: Inspect configured local gateways, explain queue state, and manage same-model acceleration through the installed Botmux gateway plugin.
---

# Gateway Acceleration

Use `botmux gateway:status` for current health, scope, acceleration, and recent
queue snapshots. Do not print control tokens or read raw runtime credential files
into a user response.

Some host versions or already-running sessions discover only globally enabled
plugin CLI commands. If this command returns the general Botmux help instead of
JSON, use the plugin's read-only, scope-checked local entrypoint:

```bash
node "$HOME/.botmux/plugins/gateway-acceleration/dist/bin/status.mjs"
```

Do not globally enable this plugin just to work around command discovery.

This local plugin connects to the existing Ferry runtimes. The plugin's auto
service manages health and commands; existing launchd supervisors still own
inference processes. Stopping the plugin service does not stop active inference.

The installer automatically checks the current environment, FERRY dependency and
personal authentication in three rows, without selecting a Bot. Missing @ad/ferry
can be installed from the internal npm registry after an explicit repair click,
with a pinned version and integrity verification. Installation
does not log in, start a gateway, or change any Bot/client model configuration.
Existing installations are reused and their supervisors are not replaced.
Never silently change model, effort, context variant, or the selected provider.

The native plugin page manages installation and plugin activation scope separately
from the acceleration switch. Use the gateway settings page for the latter.
The authenticated `/gateway status`, `/gateway on`, `/gateway off` commands can
also be used by authorized users; mutation requires management permission.

Acceleration requires a fixed supported GPT model, verified actual routing, an
enabled scope, an online gateway and a supported acceleration control adapter.
Experimental auto-model mode is mutually exclusive. Codex plus a GPT name alone
does not prove compatibility. A new official FERRY installation without the
plugin control adapter may still use FERRY's native acceleration; do not claim
that the plugin can automatically control it.

Daily settings detect the Bot CLI: Codex exposes model forwarding and acceleration
separately; a verified TraeX adapter exposes acceleration only. TraeX requires an
audited native-to-FERRY model/effort/variant mapping. The candidate managed launcher
preserves each existing session's provider. It must be deployed and verified before
claiming live integration; the presence of a TraeX binary alone is not sufficient.

Queue snapshots older than two minutes are historical, not live queue positions.
Acceleration can still queue. Do not promise zero waiting time.

No automatic restart, active request cancellation, credential export, or model
substitution is part of diagnosis.
