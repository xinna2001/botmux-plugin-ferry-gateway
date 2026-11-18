import { join } from 'node:path';
import { access } from 'node:fs/promises';
import { homePath, atomicJson, readJson } from '../../../shared/state.mjs';
import { preparationStatus } from './onboarding.mjs';
import { getJobStatus } from './setup.mjs';
import { supportedRuntime } from './runtime-instrument.mjs';

const file = home => join(home, 'plugins/gateway-acceleration/private/preparation-cache.json');
const pending = new Map();
export async function invalidatePreparation(home = homePath()) {
  await atomicJson(file(home), { schemaVersion: 1, invalidated: true });
}
export async function cachedPreparationStatus(home = homePath(), deps = {}, runtime = {}) {
  let cached = await readJson(file(home), null);
  if (runtime.upstreamVersion && cached?.version && runtime.upstreamVersion !== cached.version) {
    cached = null; // A successful generation/version switch invalidates only the stale installation result.
  }
  if (cached?.entry && !deps.setupStatus) {
    try { await access(cached.entry); } catch { cached = null; }
  }
  const now = Date.now();
  // Installation is durable; authentication is not. A local expiry check is
  // enough while valid; an explicit serving-auth rejection immediately wins.
  const authValid = cached?.authenticated === true && Date.parse(cached.authExpiresAt) > now;
  const authRecent = cached && now - cached.checkedAt < 60000;
  if (!deps.refresh && cached?.schemaVersion === 1 && !cached.invalidated
    && (cached.installed === true || authValid || authRecent || runtime.authenticated === true)) {
    const job = await getJobStatus(home);
    const authenticated = runtime.online && typeof runtime.authenticated === 'boolean' ? runtime.authenticated === true
      : authValid ? true : authRecent ? cached.authenticated : false;
    return { ...cached, authenticated, cached: true, job, serving: runtime, requiredVersion: supportedRuntime.version,
      ready: runtime.ready === true && authenticated && cached.compatible === true && cached.runtime?.ready === true,
      phase: !cached.installed ? cached.phase : !authenticated ? 'login'
        : runtime.ready ? 'ready' : runtime.online ? 'gateway-auth' : 'gateway' };
  }
  if (pending.has(home)) return pending.get(home);
  const task = (async () => {
    const value = await preparationStatus(home, deps, runtime);
    // Allowlist: never cache tokens, raw SDK responses, login URLs or secrets.
    const record = { schemaVersion: 1, checkedAt: now, installed: value.installed === true,
      version: value.version, source: value.source, detectedVersion: value.detectedVersion,
      detectedSource: value.detectedSource, compatible: value.compatible === true,
      requiredVersion: value.requiredVersion, runtime: value.runtime, phase: value.phase,
      authenticated: value.authenticated, authExpiresAt: runtime.authExpiresAt || value.authExpiresAt,
      statusError: value.statusError, entry: value.entry };
    await atomicJson(file(home), record);
    return { ...value, checkedAt: now, cached: false };
  })();
  pending.set(home, task);
  try { return await task; } finally { pending.delete(home); }
}
