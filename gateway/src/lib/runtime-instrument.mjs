import { parse } from 'acorn';
import { createHash } from 'node:crypto';

export const supportedRuntime = {
  version: '0.1.98',
  sha256: '9f26506ace21d8d2a380c9fc3e45eff1a8de0cb93105f2f5da5082e8528d748a',
};

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
  if (createHash('sha256').update(source).digest('hex') !== supportedRuntime.sha256) {
    throw new Error('FERRY 运行文件不在已核验版本中，未修改任何上游文件');
  }
  const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
  const functions = nodes(tree, node => node.type === 'FunctionDeclaration');
  const generator = one(functions.filter(node => node.id?.name === 'wi' && node.generator), 'turn-generator');
  const queue = one(functions.filter(node => node.id?.name === 'mW' && node.async), 'queue-reader');
  const changes = [];
  const insert = (offset, text) => changes.push({ start: offset, end: offset, text });
  const replace = (node, text) => changes.push({ start: node.start, end: node.end, text });
  const turn = generator.params[0].name;
  const queueTurn = queue.params[1].name;
  const emitter = queue.params[3].name;
  const queueTarget = queue.params[5].name;
  insert(generator.body.start + 1,
    `${turn}.ferryPolicy=__botmuxCreateController({...${turn},nativeAccelerationSupported:IA(${turn}.model)&&Fr(${turn}.model).startsWith("ferry-gpt-"),model:{...${turn}.model,codexId:Fr(${turn}.model)}});try{`);
  insert(generator.body.end - 1,
    `}catch(__botmuxFailure){${turn}.ferryPolicy?.finish(__botmuxFailure);throw __botmuxFailure;}finally{${turn}.ferryPolicy?.finish(${turn}.signal.aborted?${turn}.signal.reason:undefined);}`);
  insert(queue.body.start + 1,
    `const __botmuxEmit=${emitter};${emitter}=(event)=>__botmuxEmit(__botmuxObserve(${queueTurn},event,Boolean(${queueTarget}.target)));`);
  for (const caught of nodes(queue.body, node => node.type === 'CatchClause' && node.param?.type === 'Identifier')) {
    insert(caught.body.start + 1, `if(${caught.param.name} instanceof __botmuxRoute)throw ${caught.param.name};`);
  }
  const finalizer = one(nodes(queue.body, node => node.type === 'TryStatement' && node.finalizer
    && nodes(node.finalizer, child => child.type === 'Literal' && child.value === 'upstream.queued').length > 0), 'queue-finalizer').finalizer;
  const aborter = one(nodes(queue.body, node => node.type === 'VariableDeclarator'
    && node.init?.type === 'NewExpression' && node.init.callee.name === 'AbortController'), 'attempt-aborter').id.name;
  insert(finalizer.start + 1, `${aborter}.abort();`);
  const normalized = one(nodes(tree, node => node.type === 'ObjectExpression'
    && ['model', 'tools', 'requestId', 'signal', 'store'].every(name => node.properties.some(item => key(item) === name))), 'normalized-request');
  const headerSource = normalized.properties.find(item => key(item) === 'requestId').value.object.name;
  insert(normalized.end - 1, `,botmuxSessionId:${headerSource}.headers.get("x-botmux-session"),botmuxAppId:${headerSource}.headers.get("x-botmux-app"),botmuxSubagent:${headerSource}.headers.has("x-openai-subagent"),botmuxRequestedModel:t.model`);
  const modelEntries = nodes(tree, node => node.type === 'ObjectExpression'
    && ['name', 'codex', 'context', 'efforts'].every(name => node.properties.some(item => key(item) === name)));
  if (modelEntries.length < 1 || modelEntries.length > 5) throw new Error('FERRY 模型能力目录结构不匹配');
  for (const modelEntry of modelEntries) {
    const modelCall = modelEntry.properties.find(item => key(item) === 'codex').value;
    if (modelCall.type !== 'CallExpression' || modelCall.callee.name !== 'Fr'
      || modelCall.arguments[0]?.type !== 'Identifier') throw new Error('FERRY 模型能力字段无法核验');
    const model = modelCall.arguments[0].name;
    insert(modelEntry.end - 1, `,acceleration_supported:IA(${model})&&Fr(${model}).startsWith("ferry-gpt-")`);
  }
  const modelsRoute = one(nodes(tree, node => node.type === 'IfStatement' && node.consequent?.type === 'BlockStatement'
    && nodes(node.test, child => child.type === 'Literal' && child.value === '/v1/models').length === 1
    && nodes(node.test, child => child.type === 'Literal' && child.value === '/models').length === 1), 'models-route');
  const catalogDeclaration = modelsRoute.consequent.body[0];
  if (catalogDeclaration.type !== 'VariableDeclaration') throw new Error('FERRY 模型目录结构不匹配');
  insert(catalogDeclaration.end,
    'if(String(e.headers["x-ferry-client"]??"").toLowerCase()==="traex"){const __botmuxVisibility=Ri();const __botmuxModels=fA(c).filter(entry=>Fr(entry).startsWith("ferry-gpt-")).map((entry,index)=>__botmuxModelInfo(R$(entry,index,"",Mr(entry,__botmuxVisibility)?"list":"hide"),entry));return se(r,200,{models:__botmuxModels});}');
  const nativeTargets = nodes(generator.body, node => node.type === 'AwaitExpression'
    && node.argument?.type === 'CallExpression' && node.argument.callee.name === 'mi');
  if (nativeTargets.length < 1) throw new Error('FERRY 原生线路切换结构无法核验');
  nativeTargets.forEach(node => replace(node, 'undefined'));
  const retry = one(nodes(generator.body, node => node.type === 'TryStatement' && node.handler
    && nodes(node.block, child => child.type === 'CallExpression' && child.callee.name === 'mW').length === 1), 'turn-retry');
  const call = one(nodes(retry.block, node => node.type === 'CallExpression' && node.callee.name === 'mW'), 'queue-call');
  const target = call.arguments[5].name;
  const emit = call.arguments[3].name;
  const caught = retry.handler.param.name;
  insert(retry.handler.body.start + 1,
    `if(${caught} instanceof __botmuxRoute&&${turn}.ferryPolicy?.canAccelerate()){const __botmuxTarget=await mi();if(__botmuxTarget&&!${turn}.signal.aborted){${target}.target=__botmuxTarget;${target}.word=hA;${turn}.ferryPolicy.switched();${emit}({type:"switched",word:hA});}else{${turn}.ferryPolicy.unavailable();}m--;continue;}if(${turn}.ferryPolicy)throw ${caught};`);
  for (const [name, expected] of [['WE', 2], ['wN', 1], ['Nb', 1]]) {
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
  output = 'import {createController as __botmuxCreateController,FerryRoute as __botmuxRoute,observeEvent as __botmuxObserve,adaptTraexModelInfo as __botmuxModelInfo} from "./botmux-policy.mjs";\n' + output;
  parse(output, { ecmaVersion: 'latest', sourceType: 'module' });
  return { code: output, upstreamVersion: supportedRuntime.version, edits: changes.length };
}
