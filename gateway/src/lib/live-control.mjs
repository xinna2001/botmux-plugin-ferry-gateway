import { readFileSync, watchFile, unwatchFile } from 'node:fs';
import { join } from 'node:path';

const pluginId = 'gateway-acceleration';
const monitors = new Map();

// Called only inside the existing management-authority/config transaction.
// This is a live acceleration overlay, not a rewrite of historical model,
// provider, forwarding, or topic snapshots.
export function setLiveAcceleration(config, appId, enabled, now = Date.now()) {
  const revision = (config.liveControls?.revision || 0) + 1;
  config.liveControls = {
    schemaVersion: 1, revision,
    bots: { ...config.liveControls?.bots, [appId]: { enabled, revision, changedAt: now } },
  };
}

function read(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch { return null; }
}

function readState(home) {
  const config = read(join(home, 'plugins', pluginId, 'config.json'));
  const bots = read(join(home, 'bots.json'));
  const global = read(join(home, 'config.json')) || {};
  const registry = read(join(home, 'plugins-registry.json')) || {};
  if (!config || !Array.isArray(bots)) return { valid: false };
  // Never retain or publish credentials from bots.json.
  return { valid: true, controls: config.liveControls?.bots || {},
    installed: !!registry.plugins?.[pluginId],
    globalScope: global.plugins?.includes(pluginId) === true,
    scopes: Object.fromEntries(bots.map(bot => [bot.larkAppId, bot.plugins?.includes(pluginId) === true])) };
}

export function liveControlValue(state, appId) {
  if (!state?.valid) return { enabled: false, revision: 0, reason: 'control-unavailable' };
  if (!state.installed || !(state.globalScope || state.scopes[appId])) {
    return { enabled: false, revision: state.controls[appId]?.revision || 0, reason: 'host-scope-off' };
  }
  const value = state.controls[appId];
  return { enabled: value?.enabled !== false, revision: value?.revision || 0,
    changedAt: value?.changedAt, explicitlyEnabled: value?.enabled === true,
    reason: value?.enabled === false ? 'bot-acceleration-off' : undefined };
}

// One bounded monitor per serving home, shared by all active controllers.
// No per-request file polling and no background model/rank probes.
export function liveControlMonitor(home) {
  if (monitors.has(home)) return monitors.get(home);
  let state = readState(home), signature = JSON.stringify(state), listening = false;
  const listeners = new Set();
  const files = [
    join(home, 'plugins', pluginId, 'config.json'), join(home, 'bots.json'),
    join(home, 'config.json'), join(home, 'plugins-registry.json'),
  ];
  const refresh = () => {
    const next = readState(home), encoded = JSON.stringify(next);
    if (encoded === signature) return;
    state = next; signature = encoded;
    for (const callback of [...listeners]) { try { callback(); } catch {} }
  };
  const monitor = {
    get: appId => { if (!listening) refresh(); return liveControlValue(state, appId); },
    subscribe(callback) {
      listeners.add(callback);
      if (!listening) {
        refresh();
        for (const file of files) watchFile(file, { interval: 250, persistent: false }, refresh);
        listening = true;
      }
      return () => {
        listeners.delete(callback);
        if (listeners.size) return;
        for (const file of files) unwatchFile(file, refresh);
        listening = false;
        monitors.delete(home);
      };
    },
  };
  monitors.set(home, monitor);
  return monitor;
}
