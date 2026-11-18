import { parse } from 'acorn';
import { createHash } from 'node:crypto';

export const INSTRUMENTATION_REVISION = '1.0.0-4';
export const supportedRuntimes = Object.freeze({
  '0.1.98': { version: '0.1.98',
    sha256: '9f26506ace21d8d2a380c9fc3e45eff1a8de0cb93105f2f5da5082e8528d748a',
    symbols: { turn: 'wi', queue: 'mW', eligible: 'IA', model: 'Fr', target: 'mi',
      visibility: 'Ri', sorted: 'fA', modelInfo: 'R$', visible: 'Mr', reply: 'se', word: 'hA',
      globals: { WE: 2, wN: 1, Nb: 1 }, intent: 'bR' } },
  '0.1.120': { version: '0.1.120',
    sha256: 'ba3ab060671b41b04b400795749de6f0162f4dca9ade232c59c44f6d7b9a2ffe',
    symbols: { turn: 'xi', queue: 'z$', eligible: 'bA', model: 'xr', target: 'Ui',
      visibility: 'vi', sorted: 'wA', modelInfo: 'Zb', visible: 'Lr', reply: 'oe', word: 'gn',
      globals: { JQ: 2, ck: 1, Kk: 1 }, rejected: 'tQ', markRejected: 'kN',
      clearRejected: 'TN', intent: 'UN' } },
});
export const supportedRuntime = supportedRuntimes['0.1.120'];
export function runtimeVersion(version) {
  const runtime = Object.hasOwn(supportedRuntimes, version) ? supportedRuntimes[version] : undefined;
  if (!runtime) throw new Error(`FERRY ${version} 不在已核验版本中`);
  return runtime;
}
export function sourceRuntime(hash, version) {
  return Object.values(supportedRuntimes).find(r => r.sha256 === hash && (!version || r.version === version));
}

function nodes(root, predicate) {
  const found = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (typeof node.type === 'string' && predicate(node)) found.push(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(root);
  return found;
}
function one(values, name) {
  if (values.length !== 1) throw new Error(`FERRY 适配结构不匹配：${name}`);
  return values[0];
}
const key = node => node.key?.name ?? node.key?.value;

export function instrumentRuntime(source) {
  const runtime = sourceRuntime(createHash('sha256').update(source).digest('hex'));
  if (!runtime) {
    throw new Error('FERRY 运行文件不在已核验版本中，未修改任何上游文件');
  }
  // Verify the exact bytes first, then use character offsets for the AST edits.
  // Node readFile() may return a Buffer, whose slice offsets are byte offsets.
  if (Buffer.isBuffer(source)) source = source.toString('utf8');
  const symbols = runtime.symbols;
  const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
  const functions = nodes(tree, node => node.type === 'FunctionDeclaration');
  const generator = one(functions.filter(node => node.id?.name === symbols.turn && node.generator), 'turn-generator');
  const queue = one(functions.filter(node => node.id?.name === symbols.queue && node.async), 'queue-reader');
  const changes = [];
  const insert = (offset, text) => changes.push({ start: offset, end: offset, text });
  const replace = (node, text) => changes.push({ start: node.start, end: node.end, text });
  const turn = generator.params[0].name;
  const queueTurn = queue.params[1].name;
  const emitter = queue.params[3].name;
  const queueTarget = queue.params[5].name;
  insert(generator.body.start + 1,
    `${turn}.ferryPolicy=__botmuxCreateController({...${turn},nativeAccelerationSupported:${symbols.eligible}(${turn}.model)&&${symbols.model}(${turn}.model).startsWith("ferry-gpt-"),model:{...${turn}.model,codexId:${symbols.model}(${turn}.model)}${symbols.rejected ? `,nativeAccelerationPermitted:()=>!${symbols.rejected}(${turn}.sessionId),nativeClearRejection:()=>${symbols.clearRejected}(${turn}.sessionId)` : ''}});try{`);
  insert(generator.body.end - 1,
    `}catch(__botmuxFailure){${turn}.ferryPolicy?.finish(__botmuxFailure);throw __botmuxFailure;}finally{${turn}.ferryPolicy?.finish(${turn}.signal.aborted?${turn}.signal.reason:undefined);}`);
  insert(queue.body.start + 1,
    `const __botmuxEmit=${emitter};${emitter}=(event)=>__botmuxEmit(__botmuxObserve(${queueTurn},event,Boolean(${queueTarget}.target)));${queueTurn}.ferryPolicy?.setNotice(text=>${emitter}({type:"notice",text}));`);
  const alternativeProbe = one(nodes(queue.body, node => node.type === 'CallExpression'
    && node.arguments[0]?.type === 'MemberExpression'
    && node.arguments[0].object?.name === queueTurn && node.arguments[0].property?.name === 'model'
    && node.arguments[1]?.type === 'MemberExpression' && node.arguments[1].property?.name === 'position'),
  'queue-alternative-probe');
  // Managed automatic routing no longer waits on the optional rank hint.
  // Avoid repeatedly issuing probes for every queued event when the probe
  // endpoint is itself rate-limited. Unmanaged native behavior is unchanged.
  replace(alternativeProbe, `(${queueTurn}.ferryPolicy||${queueTurn}.botmuxForwardOnly?undefined:${source.slice(alternativeProbe.start, alternativeProbe.end)})`);
  const attemptTry = one(nodes(queue.body, node => node.type === 'TryStatement' && node.finalizer
    && nodes(node.finalizer, child => child.type === 'Literal' && child.value === 'upstream.queued').length > 0), 'queue-finalizer');
  const abortDefinition = one(nodes(queue.body, node => node.type === 'VariableDeclarator'
    && node.init?.type === 'NewExpression' && node.init.callee.name === 'AbortController'), 'attempt-aborter');
  const aborter = abortDefinition.id.name;
  const declaration = one(nodes(queue.body, node => node.type === 'VariableDeclaration'
    && node.declarations.includes(abortDefinition)), 'attempt-aborter-declaration');
  insert(declaration.end, `${queueTurn}.ferryPolicy?.bindAbort(reason=>${aborter}.abort(reason));`);
  insert(attemptTry.handler.body.start + 1,
    `if(${aborter}.signal.reason instanceof __botmuxRoute)throw ${aborter}.signal.reason;if(${attemptTry.handler.param.name} instanceof __botmuxRoute)throw ${attemptTry.handler.param.name};`);
  insert(attemptTry.finalizer.start + 1, `${queueTurn}.ferryPolicy?.clearAttempt();${aborter}.abort();`);
  const retryable = one(nodes(attemptTry.handler.body, node => node.type === 'VariableDeclarator'
    && nodes(node.init, child => child.type === 'MemberExpression' && child.property?.name === 'retryable').length === 1),
  'native-step-retry-condition');
  replace(retryable.init, `(${source.slice(retryable.init.start, retryable.init.end)}&&!${queueTurn}.ferryPolicy?.generated)`);
  const errorClass = one(nodes(retryable.init, node => node.type === 'BinaryExpression'
    && node.operator === 'instanceof'), 'native-upstream-error-class').right.name;
  const rawCall = one(nodes(attemptTry.block, node => node.type === 'CallExpression'
    && node.arguments[1]?.type === 'ObjectExpression'
    && ['signal','requestId','target'].every(name => node.arguments[1].properties.some(p => key(p) === name))),
  'raw-chat-call');
  insert(rawCall.arguments[1].end - 1, `,botmuxManaged:Boolean(${queueTurn}.ferryPolicy)`);
  const raw = one(functions.filter(node => node.id?.name === rawCall.callee.name), 'raw-chat-wrapper');
  const dispatch = one(nodes(raw.body, node => node.type === 'ReturnStatement'
    && node.argument?.type === 'CallExpression'), 'raw-chat-dispatch').argument;
  const transportOptions = dispatch.arguments[3];
  if (transportOptions?.type !== 'ObjectExpression') throw new Error('FERRY 请求上下文结构不匹配');
  insert(transportOptions.end - 1, `,botmuxManaged:${raw.params[1].name}.botmuxManaged`);
  const transport = one(functions.filter(node => node.id?.name === dispatch.callee.name), 'native-http-transport');
  if (transport.params.length !== 4) throw new Error('FERRY HTTP 参数结构不匹配');
  const optionsName = transport.params[3].name;
  const responseOk = one(nodes(transport.body, node => node.type === 'IfStatement'
    && nodes(node.test, child => child.type === 'MemberExpression' && child.property?.name === 'ok').length === 1
    && node.consequent?.type === 'ReturnStatement'), 'native-http-response');
  const response = one(nodes(responseOk.test, node => node.type === 'MemberExpression'
    && node.property?.name === 'ok'), 'native-http-response-object').object.name;
  insert(responseOk.end,
    `if(${optionsName}.botmuxManaged&&${optionsName}.target&&[429,503].includes(${response}.status)){const __botmuxAfter=__botmuxRetryAfter(${response}.headers.get("retry-after"));await ${response}.body?.cancel();throw Object.assign(new ${errorClass}("TRAE returned HTTP "+${response}.status,{status:${response}.status,code:${response}.status===429?"rate_limited":"upstream_unavailable",retryable:true}),{retryAfterMs:__botmuxAfter});}`);
  for (const branch of nodes(attemptTry.handler.body, node => node.type === 'IfStatement'
    && nodes(node.consequent, child => child.type === 'Literal' && child.value === 'turn.reasoning_dropped').length === 1)) {
    replace(branch.test, `(${source.slice(branch.test.start, branch.test.end)}&&!${queueTurn}.ferryPolicy?.generated)`);
  }
  const endQueue = one(nodes(queue.body, node => node.type === 'IfStatement'
    && nodes(node.test, child => child.type === 'Literal' && child.value === 'queue_end').length === 1), 'queue-end');
  const event = one(nodes(endQueue.test, node => node.type === 'MemberExpression' && node.property?.name === 'kind'), 'queue-event').object.name;
  insert(endQueue.consequent.start + 1, `${queueTurn}.ferryPolicy?.queueEnded();`);
  insert(endQueue.end,
    `if(!["queue","queue_end","metadata"].includes(${event}.kind)&&${queueTurn}.ferryPolicy?.generatedOutput(["text","reasoning","tool_call","extra_info"].includes(${event}.kind)))${emitter}({type:"notice",text:${queueTurn}.ferryPolicy.acceptanceMessage()});`);
  const failureLogs = nodes(queue.body, node => node.type === 'CallExpression'
    && ['overseas.failed', 'overseas.model_down'].includes(node.arguments[1]?.value));
  if (failureLogs.length !== (symbols.rejected ? 2 : 1)) throw new Error('FERRY 加速失败处理结构不匹配');
  for (const failureLog of failureLogs) {
    const caughtError = attemptTry.handler.param.name;
    const notify = !symbols.rejected || failureLog.arguments[1].value === 'overseas.model_down'
      ? `,${queueTurn}.ferryPolicy&&${emitter}({type:"notice",text:${queueTurn}.ferryPolicy.recoveryMessage})` : '';
    replace(failureLog,
      `(${queueTurn}.ferryPolicy?.returnedToOrdinary(${caughtError})${notify},${source.slice(failureLog.start, failureLog.end)})`);
    {
      const candidates = nodes(queue.body, node => node.type === 'IfStatement'
        && nodes(node.consequent, child => child === failureLog).length === 1);
      const branch = candidates.sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
      if (!branch) throw new Error('FERRY 加速回退分支无法核验');
      replace(branch.test,
        failureLog.arguments[1].value === 'overseas.model_down'
          ? `((${source.slice(branch.test.start, branch.test.end)})&&!${queueTurn}.ferryPolicy?.generated)`
          : `(${queueTurn}.ferryPolicy?Boolean(${queueTarget}.target)&&!${queueTurn}.ferryPolicy.generated&&!${queueTurn}.signal.aborted:(${source.slice(branch.test.start, branch.test.end)}))`);
    }
  }
  for (const notice of nodes(queue.body, node => node.type === 'ObjectExpression'
    && node.properties.some(p => key(p) === 'type' && p.value?.value === 'notice'))) {
    const text = notice.properties.find(p => key(p) === 'text')?.value;
    if (!text) throw new Error('FERRY 加速失败提示结构不匹配');
    replace(text, `(${queueTurn}.ferryPolicy?.recoveryMessage||${source.slice(text.start, text.end)})`);
  }
  const normalized = one(nodes(tree, node => node.type === 'ObjectExpression'
    && ['model', 'tools', 'requestId', 'signal', 'store'].every(name => node.properties.some(item => key(item) === name))), 'normalized-request');
  const headerSource = normalized.properties.find(item => key(item) === 'requestId').value.object.name;
  const nativeSession = normalized.properties.find(item => key(item) === 'sessionId')?.value;
  if (!nativeSession) throw new Error('FERRY 原生会话身份入口无法核验');
  insert(normalized.end - 1, `,botmuxNativeSessionId:__botmuxNativeSessionId(${headerSource}.headers,${source.slice(nativeSession.start, nativeSession.end)})`);
  insert(normalized.end - 1, `,botmuxSessionId:${headerSource}.headers.get("x-botmux-session"),botmuxAppId:${headerSource}.headers.get("x-botmux-app"),botmuxSubagent:__botmuxAuxiliaryRequest(${headerSource}.headers),botmuxForwardOnly:${headerSource}.headers.get("x-botmux-forward-only")==="true",botmuxRequestedModel:t.model`);
  const modelEntries = nodes(tree, node => node.type === 'ObjectExpression'
    && ['name', 'codex', 'context', 'efforts'].every(name => node.properties.some(item => key(item) === name)));
  if (modelEntries.length < 1 || modelEntries.length > 5) throw new Error('FERRY 模型能力目录结构不匹配');
  for (const modelEntry of modelEntries) {
    const modelCall = modelEntry.properties.find(item => key(item) === 'codex').value;
    if (modelCall.type !== 'CallExpression' || modelCall.callee.name !== symbols.model
      || modelCall.arguments[0]?.type !== 'Identifier') throw new Error('FERRY 模型能力字段无法核验');
    const model = modelCall.arguments[0].name;
    insert(modelEntry.end - 1, `,acceleration_supported:${symbols.eligible}(${model})&&${symbols.model}(${model}).startsWith("ferry-gpt-")`);
  }
  const modelsRoute = one(nodes(tree, node => node.type === 'IfStatement' && node.consequent?.type === 'BlockStatement'
    && nodes(node.test, child => child.type === 'Literal' && child.value === '/v1/models').length === 1
    && nodes(node.test, child => child.type === 'Literal' && child.value === '/models').length === 1), 'models-route');
  const catalogDeclaration = modelsRoute.consequent.body[0];
  if (catalogDeclaration.type !== 'VariableDeclaration') throw new Error('FERRY 模型目录结构不匹配');
  insert(catalogDeclaration.end,
    `if(String(e.headers["x-ferry-client"]??"").toLowerCase()==="traex"){const __botmuxVisibility=${symbols.visibility}();const __botmuxModels=${symbols.sorted}(c).filter(entry=>${symbols.model}(entry).startsWith("ferry-gpt-")).map((entry,index)=>__botmuxModelInfo(${symbols.modelInfo}(entry,index,"",${symbols.visible}(entry,__botmuxVisibility)?"list":"hide"),entry));return ${symbols.reply}(r,200,{models:__botmuxModels});}`);
  const nativeTargets = nodes(generator.body, node => node.type === 'AwaitExpression'
    && node.argument?.type === 'CallExpression' && node.argument.callee.name === symbols.target);
  if (nativeTargets.length < 1) throw new Error('FERRY 原生线路切换结构无法核验');
  nativeTargets.forEach(node => replace(node, 'undefined'));
  const retry = one(nodes(generator.body, node => node.type === 'TryStatement' && node.handler
    && nodes(node.block, child => child.type === 'CallExpression' && child.callee.name === symbols.queue).length === 1), 'turn-retry');
  const call = one(nodes(retry.block, node => node.type === 'CallExpression' && node.callee.name === symbols.queue), 'queue-call');
  const target = call.arguments[5].name;
  const emit = call.arguments[3].name;
  const caught = retry.handler.param.name;
  const loop = one(nodes(generator.body, node => node.type === 'ForStatement'
    && nodes(node.body, n => n === retry).length === 1), 'retry-loop');
  const counter = loop.init.declarations[0].id.name;
  insert(loop.start,
    `if(${turn}.ferryPolicy?.wantsContinuation()){const __botmuxStickyTarget=await ${symbols.target}();if(__botmuxStickyTarget&&${turn}.ferryPolicy.continued()){${target}.target=__botmuxStickyTarget;${target}.word=${symbols.word};}else if(!__botmuxStickyTarget&&${turn}.ferryPolicy.canAccelerate()){${turn}.ferryPolicy.unavailable();}}`);
  insert(retry.handler.body.start + 1,
    `if(${caught} instanceof __botmuxRoute&&${turn}.ferryPolicy&&!${turn}.ferryPolicy.generated&&!${turn}.signal.aborted){if(${caught}.action==="ordinary"||!${turn}.ferryPolicy.canAccelerate()){${target}.target=undefined;${target}.word=undefined;${turn}.ferryPolicy.returnedByControl();${emit}({type:"notice",text:"同模型加速已关闭，继续普通线路等待"});}else{const __botmuxTarget=await ${symbols.target}();if(__botmuxTarget&&${turn}.ferryPolicy.canAccelerate()){${target}.target=__botmuxTarget;${target}.word=${symbols.word};${turn}.ferryPolicy.switched();${emit}({type:"notice",text:${turn}.ferryPolicy.attemptMessage()});}else if(!${turn}.ferryPolicy.canAccelerate()){${turn}.ferryPolicy.returnedByControl();}else{${turn}.ferryPolicy.unavailable();}}${counter}--;continue;}if(${turn}.ferryPolicy)throw ${caught};`);
  if (symbols.intent) {
    const intent = one(nodes(generator.body, node => node.type === 'VariableDeclaration'
      && node.declarations.some(d => d.init?.type === 'CallExpression' && d.init.callee.name === symbols.intent)), 'native-intent');
    const definition = intent.declarations.find(d => d.init?.callee?.name === symbols.intent);
    const state = definition.id.name;
    replace(definition.init,
      `(${turn}.botmuxSubagent||${turn}.botmuxForwardOnly||(${turn}.ferryPolicy&&!${turn}.ferryPolicy.mayControl)?{messages:${turn}.messages,requested:false,now:false,earlier:false}:${source.slice(definition.init.start, definition.init.end)})`);
    insert(intent.end, `if(${state}.cancelled)${turn}.ferryPolicy?.suppress("manual-cancel");else if(${state}.now)${turn}.ferryPolicy?.resume();`);
    for (const rejected of nodes(queue.body, n => symbols.markRejected && n.type === 'CallExpression' && n.callee.name === symbols.markRejected)) {
      replace(rejected, `(${queueTurn}.ferryPolicy?.hasScheduledRetry()?undefined:${source.slice(rejected.start, rejected.end)})`);
    }
  }
  for (const [name, expected] of Object.entries(symbols.globals)) {
    const callSites = nodes(tree, node => node.type === 'CallExpression' && node.callee.name === name);
    if (callSites.length !== expected) throw new Error(`FERRY 全局副作用结构不匹配：${name}`);
    callSites.forEach(node => replace(node, 'undefined'));
  }
  let output = source;
  let boundary = source.length;
  for (const change of changes.sort((left, right) => right.start - left.start || right.end - left.end)) {
    if (change.end > boundary) throw new Error('FERRY 适配修改存在重叠');
    output = output.slice(0, change.start) + change.text + output.slice(change.end);
    boundary = change.start;
  }
  output = output.replace(/^#![^\n]*\n/, '');
  output = 'import {createController as __botmuxCreateController,FerryRoute as __botmuxRoute,observeEvent as __botmuxObserve,adaptTraexModelInfo as __botmuxModelInfo,retryAfterMilliseconds as __botmuxRetryAfter,managedNativeSessionId as __botmuxNativeSessionId,requestIsAuxiliary as __botmuxAuxiliaryRequest} from "./botmux-policy.mjs";\n' + output;
  parse(output, { ecmaVersion: 'latest', sourceType: 'module' });
  return { code: output, upstreamVersion: runtime.version, edits: changes.length };
}
