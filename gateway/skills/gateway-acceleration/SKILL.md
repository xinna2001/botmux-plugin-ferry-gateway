---
name: gateway-acceleration
description: Inspect local gateway defaults and actual topic state; manage verified same-model acceleration, finite retries, live pause, and safe recovery with the installed Botmux gateway plugin.
---

# Gateway Acceleration 1.0

## Explicit existing-topic transitions

On hosts implementing `resume-target` and `resume-target/prepare`, an authenticated
switch also creates a revision-bound routing intent for existing supported TraeX
topics. This supersedes the earlier defaults-only behavior below. Immutable topic
snapshots and original rollouts are not overwritten: separately authorized,
per-target receipts bind a visible-history copy to the same Botmux topic.

Saved switches, warming, migration admission and verified execution are different
states. Never report full OFF/ON from HTTP202, a checkbox or a listening port.
Wait for answers/tools/delivery to settle. Cold tmux topics use the host's
message-less terminal wake, not a synthesized “continue” task. Never revive closed
topics. Verify actual target identity and readiness after the correlated restart.
ON copies the latest current history, preserving work done while native.

Cross-provider copies retain visible messages and completed tools, omit explicitly
nonportable encrypted reasoning, and preserve the original file. Same-provider
generation upgrades retain reasoning. Never fabricate a successful target turn.
Receipts authorize only exact imported prefixes, model/effort/variant and verified
runtime bytes. Manual cancellation never expires merely because of a restart.

Support is deliberately narrow: local managed TraeX, live PTY/tmux and dormant
tmux. Unsupported clients/history/isolation or missing host capability must show
pending/blocked, never a guessed native fallback. Codex Ferry-only models have no
assumed native equivalent; do not change a model to make OFF appear successful.

Existing Codex FERRY topics have a separate same-provider generation upgrade:
local managed tmux only, explicit ON, verified original native ID/history/model/
effort, and host `resume-target/park` followed by message-less `prepare`.
Do not use ordinary restart for automatic migration: it can interrupt work.
The launcher preserves that same native ID and records the exact runtime it
launched; host readiness and later actual request generation are checked
separately. This does not grant cross-provider native exit or clear cancellation.

Use `botmux gateway:status` for defaults, runtime health and actual current-topic
state. If command discovery is scope-limited, use the read-only entry:

```bash
node "$HOME/.botmux/plugins/gateway-acceleration/dist/bin/status.mjs"
```

Never globally enable a plugin merely to read status. Never print tokens,
credentials, prompts or raw private runtime logs.

## Actual request evidence

A default switch is not proof of acceleration. Read currentTopic route state,
attempts/retries, cancellation/cooldown, live revision and serving generation.
Snapshots older than two minutes are historical, not live queue ranks.
Auxiliary/title/memory calls cannot overwrite main status or parent controls.
Choosing a route means attempting, not upstream acceptance.
Accepted output persists a same-conversation route preference keyed by Bot,
topic, native session, model and effort. Compatible tool continuations and
resumes start on that route, not ordinary-first-hop. The 24h preference is
renewed on accepted output; live revision changes, OFF, rejection and manual
cancel invalidate it. Never create it from notices or usage/done-only replies.
Unknown output prevents replay without falsely proving acceptance. Check
routeSource and affinityPersisted rather than counting UI success notices.

## Controls and authorization

Only explicitly authorized fixed GPT models/variants/efforts may accelerate.
Discover actual CLI architecture. Codex acceleration requires forwarding;
TraeX uses one acceleration switch. Reject unknown wrappers, automatic model
pools, unsupported efforts or isolation modes. Never substitute models, lower
effort, inflate context, disable isolation or adopt external app-server pools.
Model choice belongs only to host Bot settings.

The Bot master controls new-topic defaults, live acceleration permission and
explicit existing-topic routing intent for 1.0 requests. OFF stops retries/new attempts and returns a not-yet-generating
accelerated wait to ordinary routing. Already-generated text/reasoning/tool
output is never killed or replayed. Old provider, history, forwarding entries
and native plugin registration may remain; OFF is not uninstall or daemon stop.
Fresh native OFF launches must make zero gateway health/inference requests.
Do not call retained FERRY compatibility forwarding native direct access.
Full exit for existing encrypted histories requires a separately verified,
host-supported idle-history transition. It retains the Botmux topic while a new
native ID identifies the authorized copy; originals and completed tool effects
remain untouched. Do not promise to transport nonportable encrypted reasoning.

Old generations do not acquire new behavior just because defaults were updated.
Identify them and migrate only when explicitly authorized, preserving model,
effort and original transcript. Same-ID queued recovery and new-ID provider-copy
transitions are distinct operations. Never cancel answering or unknown-state
tasks for a toggle. Explicit ON can adopt a topic created natively while OFF only
through an owner-only target-specific receipt validated against the immutable
snapshot, exact request native ID/model/effort and known model variant. Ordinary
default changes or arbitrary caller model names cannot grant this permission.

Re-enable may reset automatic failure for an originally authorized topic, but
never clears its manual cancel. Explicit native retry is separate and cannot
bypass scope/model/effort or a narrowly authorized transition. A Ferry-only Codex model cannot cold-start
natively with forwarding OFF: require native model selection or forwarding ON.

## Bounded retry

One initial attempt plus at most three retries after 5/15/30 seconds, only for
transient failures. Honor a longer Retry-After. A timer can wake ordinary
waiting without a new queue event. Abort, queue end, actual output, OFF and
finish retire timers. Do not retry authentication/permission/exhausted-quota
failures to bypass access controls.

Manual cancel, transient recovery, retry budget and rejection cooldown are
distinct. Automatic rejection expires; manual cancel does not. Do not blindly
clear controls or create an unlimited retry loop. No speculative rank-probe
storm is needed before an authorized attempt.

Acceleration may still queue or be rejected. Never promise faster service or
zero waiting; official Ferry guidance discourages excessive shared-resource use.

## Installation and updates

Private Node/Ferry dependencies, actual serving process, SDK, personal auth and
catalog must all pass before enable. Process-online alone is not ready. SSO is
a user action; background preparation cannot log in or grant model access.
Preserve global packages and old generations.

Verified upstreams: @ad/ferry0.1.98 and0.1.120, exact independent source hashes.
Unknown versions fail closed. Version check is metadata-only; update requires
explicit confirmation and verified package/source/startup/SDK/auth/catalog
before changing defaults. Never restart old serving daemons for a new default.

Compatible hosts use managementLayout v1; others use standalone settings.
Plugin installation does not upgrade the host. Generation identity includes
adapter and policy identity, so stale preparation cannot hide an adapter fix.

## Native recovery

Resume/fork needs the explicit native ID. Prefer complete successful main-turn
model/provider/effort as one unit. Failed/default-GPT/auxiliary records cannot
replace verified Ferry configuration.

A first unfinished turn needs a recorded primary native identity and
non-generating request matching the immutable topic and complete native main
context. Never derive it from current defaults. Preserve transcript data;
the plugin does not rewrite or replay it. Explicit old recovery records remain
scoped by ID and transcript-prefix integrity. Unknown evidence fails closed.

## Connection tools

TOML export is current-model forwarding-only, with no personal/admin secrets or
Bot topic identity; it does not grant acceleration. A port change must actually
verify a listener before publishing the new default. A saved number is not
success. Old topics retain their endpoints.

## Release acceptance

Verify physical click hit-testing, keyboard Space, backend writes, persistence
and real runtime effects, plus stale GET/failed PUT/reload/reopen/cross-page
cases. Off/on must not reuse an old profile revision or let a locally merged
stale scope snapshot overwrite newly verified capabilities.

Keep deterministic upstream fixtures distinct from real authenticated/native
tests. Fixture PASS, DOM state or process alive is not production acceptance.
Publish only tested bytes, verify the registry download, installed code and
actual serving generation separately.
