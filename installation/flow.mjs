import { randomUUID } from 'node:crypto';
import { STEPS } from './steps.mjs';
export { STEPS };

export function createInstallationFlow(deps) {
  const sessions = new Map();
  const now = deps.now || Date.now;
  const publicView = item => ({
    id: item.id, state: item.state,
    steps: item.steps.map(({ id, label, state, message }) => ({ id, label, state, message })),
    expiresAt: item.expiresAt,
  });
  function requireSession(id, principal) {
    const item = sessions.get(id);
    if (!item || item.principal !== principal || item.expiresAt <= now()) throw new Error('安装检查已过期，请重新开始');
    return item;
  }
  async function begin(principal) {
    if (!principal) throw new Error('需要管理身份');
    for (const [id, item] of sessions) if (item.expiresAt <= now()) sessions.delete(id);
    if (sessions.size >= 20) throw new Error('待处理的安装过多');
    const item = {
      id: randomUUID(), principal, state: 'checking', expiresAt: now() + 15 * 60 * 1000,
      snapshot: await deps.snapshot(),
      steps: STEPS.map(step => ({ ...step, state: 'pending', message: '' })),
    };
    sessions.set(item.id, item);
    return publicView(item);
  }
  async function advance(id, principal) {
    const item = requireSession(id, principal);
    if (item.state !== 'checking') throw new Error('当前不能继续检查');
    const step = item.steps.find(step => !['passed', 'warning'].includes(step.state));
    if (!step || step.state === 'running') throw new Error('已有检查正在进行');
    step.state = 'running';
    try {
      const result = await deps.check(step.id);
      requireSession(id, principal);
      step.state = result.ok ? (result.warning ? 'warning' : 'passed') : 'blocked';
      step.message = String(result.message || '').slice(0, 500);
      if (item.steps.every(step => ['passed', 'warning'].includes(step.state))) item.state = 'ready';
      return publicView(item);
    } catch {
      step.state = 'blocked'; step.message = '检查未完成，请重试';
      return publicView(item);
    }
  }
  async function install(id, principal, confirm) {
    const item = requireSession(id, principal);
    if (confirm !== true || item.state !== 'ready') throw new Error('请完成全部检查并确认安装');
    item.state = 'installing';
    try {
      return await deps.lock(async () => {
        requireSession(id, principal);
        if (await deps.snapshot() !== item.snapshot) throw new Error('配置已变化，请重新检查');
        for (const step of STEPS) {
          if (!(await deps.check(step.id)).ok) throw new Error('安装前复核未通过，请重新检查');
        }
        requireSession(id, principal);
        if (await deps.snapshot() !== item.snapshot) throw new Error('配置已变化，请重新检查');
        const result = await deps.install();
        item.state = 'installed';
        return { ...publicView(item), result };
      });
    } catch (error) { item.state = 'failed'; throw error; }
  }
  return { begin, advance, install, view: (id, principal) => publicView(requireSession(id, principal)) };
}
