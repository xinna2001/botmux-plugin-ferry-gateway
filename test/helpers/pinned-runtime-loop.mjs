import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parse } from 'acorn';
import { Controller, FerryRoute, observeEvent, retryAfterMilliseconds } from '../../gateway/src/lib/runtime-policy.mjs';
import { instrumentRuntime, supportedRuntimes } from '../../gateway/src/lib/runtime-instrument.mjs';
import { retryClock } from './retry-clock.mjs';

export function runtimeSource(version) {
  const root = process.env[version === '0.1.98' ? 'FERRY_TEST_098_PACKAGE' : 'FERRY_TEST_120_PACKAGE']
    || join(homedir(), '.botmux/local', version === '0.1.98'
      ? 'ferry-plugin-dependency/0.1.98/node_modules/@ad/ferry' : 'ferry-plugin-dependency/0.1.120/node_modules/@ad/ferry');
  const path = join(root, 'dist/cli.js');
  return existsSync(path) ? path : null;
}
function nodes(root, predicate, found = []) {
  if (!root || typeof root !== 'object') return found;
  if (predicate(root)) found.push(root);
  for (const value of Object.values(root)) {
    if (Array.isArray(value)) value.forEach(v => nodes(v, predicate, found));
    else if (value && typeof value === 'object') nodes(value, predicate, found);
  }
  return found;
}
export class TestUpstreamError extends Error {
  constructor(message = 'Too many requests were sent in a short period. Please reduce the concurrency and try again.', fields = {}) {
    super(message); Object.assign(this, { status: 429, code: 'rate_limited', retryable: true }, fields);
  }
}
const waitAbort = signal => new Promise((_, reject) => {
  if (signal.aborted) reject(signal.reason);
  else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});
export async function flushLoop() {
  for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
}
const extracted = new Map();
async function extractLoops(version) {
  if (!extracted.has(version)) extracted.set(version, (async () => {
    const source = instrumentRuntime(await readFile(runtimeSource(version), 'utf8')).code;
    const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
    const symbols = supportedRuntimes[version].symbols;
    const queue = nodes(ast, n => n.type === 'FunctionDeclaration' && n.id?.name === symbols.queue)[0];
    const turn = nodes(ast, n => n.type === 'FunctionDeclaration' && n.id?.name === symbols.turn)[0];
    const rawCall = nodes(queue, n => n.type === 'CallExpression' && n.arguments[1]?.type === 'ObjectExpression'
      && ['signal','requestId','target'].every(k => n.arguments[1].properties.some(p => p.key?.name === k)))[0];
    const raw = nodes(ast, n => n.type === 'FunctionDeclaration' && n.id?.name === rawCall.callee.name)[0];
    const dispatch = nodes(raw, n => n.type === 'ReturnStatement' && n.argument?.type === 'CallExpression')[0].argument;
    const transport = nodes(ast, n => n.type === 'FunctionDeclaration' && n.id?.name === dispatch.callee.name)[0];
    return { symbols, code: `${source.slice(queue.start, queue.end)}\n${source.slice(turn.start, turn.end)}`,
      httpCode: `${source.slice(transport.start, transport.end)}\n${source.slice(raw.start, raw.end)}`,
      rawName: raw.id.name, configName: dispatch.arguments[0].object.object.name,
      headersName: dispatch.arguments[2].body.callee.name };
  })());
  return extracted.get(version);
}

export async function pinnedHttp(version, { status = 429, managed = true, retryAfter = '60' } = {}) {
  const data = await extractLoops(version), calls = [], delays = [], logs = [];
  const no = () => false, nop = () => {};
  const auth = { token: async () => 'owned-fixture-only', site: () => 'cn', invalidate: nop };
  const fetcher = async (url, options) => {
    calls.push({ url, body: options.body });
    return new Response('owned failure fixture', { status, headers: { 'retry-after': retryAfter } });
  };
  const logger = (level, event, value) => logs.push({ level, event, ...value });
  const delay = async ms => { delays.push(ms); };
  const globals = {
    [data.configName]: { paths: { rawChat: '/owned-fixture' } },
    [data.headersName]: () => ({ 'x-owned-fixture': 'true' }),
    se: auth, ie: auth, Fn: async () => 'http://ordinary.invalid', yn: async () => 'http://ordinary.invalid',
    Ni: nop, fi: nop, xR: fetcher, US: fetcher, jW: no, Iq: no, m: logger, R: logger,
    F: e => e.message, O: e => e.message, xI: nop, kQ: nop, du: [1,2], Zc: [1,2],
    _R: delay, LS: delay, $W: () => '', Qq: () => '', ve: Error, Ge: Error,
    j: TestUpstreamError, Z: TestUpstreamError, __botmuxRetryAfter: retryAfterMilliseconds,
  };
  const run = new Function(...Object.keys(globals), `${data.httpCode}\nreturn ${data.rawName};`)(...Object.values(globals));
  let error;
  try {
    await run({ session_id: 'owned-native', messages: [] }, {
      signal: new AbortController().signal, requestId: 'owned-http',
      target: { site: 'i18n-tt', baseUrl: 'http://owned.invalid' }, botmuxManaged: managed,
    });
  } catch (failure) { error = failure; }
  return { calls, delays, logs, error };
}

// Executes the exact instrumented, hash-verified native queue and turn
// functions. Only network/SDK/model parsing helpers are replaced with owned
// deterministic fixtures; the retry/catch/finally loops are not reimplemented.
export async function pinnedLoop(version, { accelerated, ordinary, live = { enabled: true, revision: 0 },
  clock: suppliedClock, makeController, policyModule, identity = {}, conversation = {}, targetLookup, parseIntent } = {}) {
  const { symbols, code } = await extractLoops(version);
  const clock = suppliedClock || retryClock(), abort = new AbortController(), calls = [], events = [], logs = [], snapshots = [];
  let saved = {}, controller, probes = 0, liveValue = live, targetNumber = 0;
  const rejection = new Set();
  const nativeEffects = [];
  const nop = () => {}, no = () => false;
  const intent = parseIntent || (messages => ({ messages, requested: false, now: false, earlier: false }));
  const repaired = messages => ({ messages, repairs: { orphanOutputs: 0, missingOutputs: 0, emptyOutputs: 0 } });
  const payload = (turn, messages, tools) => ({ messages, tools, model_name: turn.model.modelName,
    reasoning_effort: turn.reasoningEffort, session_id: turn.sessionId });
  const logger = (level, event, values) => logs.push({ level, event, ...values });
  const probe = () => { probes++; return 0; };
  const request = async (body, opts) => {
    const isTarget = !!opts.target, number = isTarget ? ++targetNumber : undefined;
    calls.push({ target: isTarget, at: clock.now(), number, model: body.model_name, effort: body.reasoning_effort });
    return (async function* () {
      if (isTarget) {
        const scenario = accelerated?.(number) || { error: new TestUpstreamError() };
        if (scenario.queue) yield { kind: 'queue', position: scenario.queue };
        if (scenario.tool) yield { kind: 'tool_call', index: 0, id: 'call_owned', name: 'owned_tool',
          argumentsDelta: '{"ok":true}', type: 'function' };
        if (scenario.text) yield { kind: 'text', text: scenario.text };
        if (scenario.hold) await waitAbort(opts.signal);
        if (scenario.error) throw scenario.error;
        yield { kind: 'usage', usage: { prompt: 1, completion: 1 } };
        yield { kind: 'done', finishReason: scenario.tool ? 'tool_calls' : 'stop' };
      } else {
        yield { kind: 'queue', position: 2000 };
        if (ordinary?.text) yield { kind: 'text', text: ordinary.text };
        else await waitAbort(opts.signal);
      }
    })();
  };
  const common = {
    Date: { now: clock.now }, setTimeout: clock.setTimeout,
    __botmuxObserve: policyModule?.observeEvent || observeEvent, __botmuxRoute: policyModule?.FerryRoute || FerryRoute,
    __botmuxCreateController: turn => controller = makeController ? makeController(turn, clock) : new Controller(turn, {
      enabled: !turn.botmuxSubagent && !turn.botmuxForwardOnly, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
      write: value => snapshots.push(value), readControl: () => saved, writeControl: value => { saved = value; },
      readAffinity: () => conversation.affinity || {}, writeAffinity: value => { conversation.affinity = value; },
      liveControl: () => liveValue,
      enabledNow: () => typeof turn.nativeAccelerationPermitted !== 'function' || turn.nativeAccelerationPermitted(),
    }),
  };
  const modern = {
    j: TestUpstreamError, hu: request, sN: x => x, Nu: x => x, mu: nop, _N: probe, $R: 0,
    wu: nop, J$: (usage, row) => usage.steps.push(row), O$: () => 'owned-call-id',
    A4: no, zE: no, HE: no, m: logger, YN: 2, P$: new Set(), V$: 1, MN: nop,
    kN: id => rejection.add(id), tQ: id => rejection.has(id), TN: id => { nativeEffects.push('clear-rejection'); rejection.delete(id); },
    PR: () => 'native rejection notice', K$: e => e.message, gn: '加速',
    Yu: () => ({ steps: [] }), UN: intent, bA: () => true, xr: model => model.codexId,
    Ui: targetLookup || (async () => ({ site: 'i18n-tt', baseUrl: 'http://owned-fixture.invalid' })),
    eQ: no, NN: () => nativeEffects.push('remember'), FN: no, rQ: no, xN: no, EN: x => x, DN: messages => ({ messages, moved: 0 }),
    wN: messages => ({ messages }), mN: repaired, AQ: payload, Oo: 'owned_search', QN: 0, IN: {},
    n4: no, vN: () => 1, t4: () => null, r4: nop, KE: no, e4: no, RN: no,
    G$: () => [], hN: nop, WE: x => x, $E: x => x,
    UE: () => 'withdrawn', _o: () => 'cancelled', bN: () => nativeEffects.push('cancel'), dn: '取消加速',
    Fu: x => x, xE: () => 'unavailable', ME: 'quota', FE: 'rate',
    o4: x => x, CN: x => x, BN: async () => ({ results: [] }), pN: () => '',
  };
  const legacy = {
    Z: TestUpstreamError, Kc: request, tR: x => x, hu: x => x, au: nop, FR: probe, JS: 0,
    cu: nop, EW: (usage, row) => usage.steps.push(row), gW: () => 'owned-call-id',
    NW: no, fE: no, R: logger, UR: 2, fW: new Set(), dW: 1, SR: nop,
    CE: () => ({ steps: [] }), bR: intent, IA: () => true, Fr: model => model.codexId,
    mi: targetLookup || (async () => ({ site: 'i18n-tt', baseUrl: 'http://owned-fixture.invalid' })),
    DR: no, wR: () => nativeEffects.push('remember'), RR: no, NR: no, kR: no, uR: x => x, CR: messages => ({ messages, moved: 0 }),
    IR: messages => ({ messages }), QR: repaired, QE: payload, Ns: 'owned_search', lR: 0, gR: {},
    RW: no, MR: () => 1, DW: () => null, SW: nop, dE: no, wW: no, yR: no,
    hW: () => [], aR: nop, cE: x => x, uE: x => x, zf: 'quota', eE: 'rate', hA: '加速',
    bW: x => x, hR: x => x, dR: async () => ({ results: [] }), fR: () => '',
  };
  const globals = { ...common, ...(version === '0.1.120' ? modern : legacy) };
  const factory = new Function(...Object.keys(globals),
    `${code}\nreturn ${symbols.turn};`);
  const run = factory(...Object.values(globals));
  const turn = { botmuxAppId: 'cli_owned_loop', botmuxSessionId: '00000000-0000-4000-8000-000000000092',
    requestId: 'owned-loop-request', sessionId: 'owned-native-id', botmuxRequestedModel: 'ferry-gpt-6-1-sol-max',
    model: { codexId: 'ferry-gpt-6-1-sol-max', modelName: 'gpt-6.1-sol__max', configName: 'gpt-6.1-sol' },
    reasoningEffort: 'xhigh', messages: [{ role: 'user', content: [{ type: 'text', text: 'owned test' }] }],
    tools: [], signal: abort.signal, ...identity };
  const result = (async () => { for await (const event of run(turn)) events.push(event); return events; })();
  // Observe rejection immediately to avoid an unhandled rejection while a
  // test is advancing its deterministic clock.
  result.catch(() => {});
  await flushLoop();
  return { clock, abort, calls, events, logs, snapshots, result, nativeEffects,
    get controller() { return controller; }, get saved() { return saved; }, get probes() { return probes; },
    live(value) { liveValue = value; controller.syncLive(); },
  };
}
