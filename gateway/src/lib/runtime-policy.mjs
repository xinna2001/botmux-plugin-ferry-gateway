import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

const sessionPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const appPattern = /^cli_[a-zA-Z0-9_]{3,80}$/;
const pluginId = 'gateway-acceleration';
const homePath = () => process.env.BOTMUX_FERRY_CONTROL_HOME || join(homedir(), '.botmux');
const read = (file, fallback) => {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch { return fallback; }
};

export class FerryRoute extends Error {
  constructor() {
    super('same-model-acceleration');
    this.action = 'accelerate';
  }
}

export function accelerationDecision(turn, { bot, binding, global, installed }) {
  const modelId = turn.model?.codexId;
  if (!installed || !bot || !binding || turn.botmuxSubagent) return false;
  if (turn.nativeAccelerationSupported !== true) return false;
  if (!['codex', 'traex'].includes(bot.cliId) || binding.architecture !== bot.cliId) return false;
  if (!bot.plugins?.includes(pluginId) && !global.plugins?.includes(pluginId)) return false;
  if (bot.model === 'auto' || bot.traexAutoModel?.enabled === true) return false;
  if (binding.acceleration !== true || (bot.cliId === 'codex' && binding.forwarding !== true)) return false;
  if (binding.selection?.accelerationAvailable !== true) return false;
  if (!/^ferry-gpt-[a-z0-9-]+$/.test(modelId || '')) return false;
  if (turn.botmuxRequestedModel !== modelId || binding.selection?.ferryModel !== modelId) return false;
  if (bot.model !== binding.selection.clientModel) return false;
  if (bot.cliId === 'traex' && (bot.modelBackendVariant || 'standard') !== binding.selection.backendVariant) return false;
  const effort = bot.reasoningEffort || 'medium';
  return turn.reasoningEffort === effort && binding.selection.efforts?.includes(effort) === true;
}

export function createController(turn, deps = {}) {
  if (!appPattern.test(turn.botmuxAppId || '') || !sessionPattern.test(turn.botmuxSessionId || '')) return undefined;
  if (turn.botmuxRequestedModel !== turn.model?.codexId) throw new Error('Requested model does not match the resolved Ferry model');
  const home = deps.home || homePath();
  const config = read(join(home, 'plugins', pluginId, 'config.json'), {});
  const bots = read(join(home, 'bots.json'), []);
  const bot = Array.isArray(bots) ? bots.find(value => value.larkAppId === turn.botmuxAppId) : null;
  const binding = config.controlPlane?.bots?.[turn.botmuxAppId];
  const global = read(join(home, 'config.json'), {});
  const installed = !!read(join(home, 'plugins-registry.json'), {}).plugins?.[pluginId];
  const enabled = accelerationDecision(turn, { bot, binding, global, installed });
  return new Controller(turn, { ...deps, home, enabled });
}

export class Controller {
  constructor(turn, deps = {}) {
    this.enabled = deps.enabled === true;
    this.generated = false;
    this.moved = false;
    this.offerAttempted = false;
    this.finished = false;
    this.now = deps.now || Date.now;
    this.signal = turn.signal;
    this.write = deps.write || (snapshot => {
      const folder = join(deps.home || homePath(), 'plugins', pluginId, 'private', 'requests', turn.botmuxAppId);
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      const target = join(folder, `${turn.botmuxSessionId}.json`);
      const current = read(target, null);
      if (this.initialized && current?.requestId !== turn.requestId) return;
      const temporary = `${target}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify(snapshot), { mode: 0o600 });
      renameSync(temporary, target);
    });
    this.snapshot = {
      appId: turn.botmuxAppId, sessionId: turn.botmuxSessionId, requestId: turn.requestId,
      model: turn.model?.codexId, reasoningEffort: turn.reasoningEffort,
      startedAt: this.now(), phase: 'waiting', accelerationEnabled: this.enabled, moved: false,
    };
    this.publish();
    this.initialized = true;
  }
  publish(patch = {}) {
    Object.assign(this.snapshot, patch, { observedAt: this.now() });
    try { this.write({ ...this.snapshot }); } catch {}
  }
  canAccelerate() {
    return this.enabled && !this.generated && !this.finished && !this.signal?.aborted;
  }
  queue(position, alternative, moved = false) {
    this.moved = !!moved;
    this.publish({ phase: 'queued', position, alternative, moved: this.moved });
    if (this.canAccelerate() && !this.moved && !this.offerAttempted
      && Number.isFinite(position) && position > 0 && Number.isFinite(alternative) && alternative >= 0) {
      this.offerAttempted = true;
      return new FerryRoute();
    }
  }
  switched() {
    this.moved = true;
    this.publish({ phase: 'waiting', moved: true });
  }
  unavailable() {
    this.moved = false;
    this.publish({ phase: 'waiting', moved: false, unavailable: true });
  }
  generatedOutput() {
    this.generated = true;
    this.publish({ phase: 'answering' });
  }
  finish(error) {
    if (this.finished) return;
    this.finished = true;
    this.publish({ phase: error ? 'error' : 'complete' });
  }
}

export function observeEvent(turn, event, moved) {
  if (event?.type === 'queue') {
    const route = turn.ferryPolicy?.queue(event.position, event.alternative, moved);
    if (route) throw route;
    if (turn.ferryPolicy) return { ...event, alternative: undefined };
  }
  if (event?.type && !['queue', 'waiting', 'started', 'switched'].includes(event.type)) turn.ferryPolicy?.generatedOutput();
  return event;
}

export function adaptTraexModelInfo(info, model) {
  return {
    ...info,
    model_provider_id: 'botmux_ferry',
    config_name: String(model.modelName || '').split('__')[0],
    harness_mode: 'codex',
    model_family: 'gpt',
  };
}
