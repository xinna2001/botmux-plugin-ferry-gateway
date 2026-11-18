import { join } from 'node:path';
import { readJson, atomicJson, withLock, pluginConfig, digest, homePath, validateAppId } from '../../../shared/state.mjs';
import { managementAuthority, assertManagementAuthority } from './host-control.mjs';
import { ensureManagedRuntime } from './managed-runtime.mjs';

export async function applyManagedPort(input, home = homePath(), deps = {}) {
  if (input.confirm !== true) throw new Error('需要明确确认将新话题网关切换端口；旧话题不改线路');
  if (!Number.isInteger(input.port) || input.port < 1024 || input.port > 65535) throw new Error('端口必须在 1024–65535 之间');
  return withLock(join(home, 'plugins/gateway-acceleration/private/connection-operation'), async () => {
    const authority = await managementAuthority(home);
    const configFile = pluginConfig('gateway-acceleration', home);
    const before = await readJson(configFile);
    if (input.revision !== digest(before)) throw new Error('配置已变化，请刷新后重试');
    await assertManagementAuthority(home, authority);
    // The manager publishes only a source-verified, authenticated, healthy
    // candidate. An occupied port/failure leaves the serving pointer intact.
    const runtime = await (deps.ensureManagedRuntime || ensureManagedRuntime)(home, {
      ...deps, requestedPort: input.port, requireReadyBeforePublish: true,
      beforePublish: async () => {
        await deps.beforePublish?.();
        await assertManagementAuthority(home, authority);
      },
    });
    if (runtime.ready !== true || runtime.port !== input.port) throw new Error('FERRY 端口未实际生效，未宣称保存成功');
    await assertManagementAuthority(home, authority);
    await withLock(configFile, async () => {
      const config = await readJson(configFile);
      config.connection = { ...config.connection, lastAppliedPort: runtime.port, appliedAt: Date.now(),
        effect: 'new-topics-only' };
      await atomicJson(configFile, config);
    });
    return { applied: true, port: runtime.port, effect: 'new-topics-only', oldTopicsPreserved: true };
  });
}

// Restores the old read-only export capability without reintroducing a second
// model selector or exporting login/admin secrets. No Bot routing is mutated.
export function forwardingConfiguration(snapshot, appId) {
  validateAppId(appId);
  if (snapshot.runtime?.ready !== true || !Number.isInteger(snapshot.runtime.port)) throw new Error('FERRY 实际网关未就绪，不能导出连接配置');
  const profile = snapshot.profiles?.find(p => p.appId === appId);
  const choice = profile?.modelChoices?.find(m => m.id === profile.selectedModelId);
  if (!profile || !['codex','traex'].includes(profile.cliId) || !choice
    || !/^ferry-gpt-[a-z0-9-]+$/.test(choice.ferryModel || '')
    || !choice.efforts?.includes(profile.reasoningEffort)) throw new Error('当前模型或档位尚未核验，不能导出');
  const q = JSON.stringify;
  return { filename: `${profile.cliId}-ferry.toml`, forwardingOnly: true,
    content: [
      '# 本机转发配置；模型与档位来自 Bot 设置。此导出不启用同模型加速，不接管任何 Bot 话题。',
      '# 不包含个人登录信息或管理令牌。旧话题保持原线路；此地址是当前新话题默认网关。',
      `model = ${q(choice.ferryModel)}`, 'model_provider = "botmux_ferry"',
      `model_reasoning_effort = ${q(profile.reasoningEffort)}`,
      ...(Number.isInteger(choice.contextWindow) ? [`model_context_window = ${choice.contextWindow}`] : []),
      '[model_providers.botmux_ferry]', 'name = "FERRY"',
      `base_url = ${q(`http://127.0.0.1:${snapshot.runtime.port}/v1`)}`, 'wire_api = "responses"',
      'requires_openai_auth = false',
      '[model_providers.botmux_ferry.auth]', 'command = "printf"', 'args = ["ferry"]',
      '[model_providers.botmux_ferry.http_headers]', `"x-ferry-client" = ${q(profile.cliId)}`,
      '"x-botmux-forward-only" = "true"', '',
    ].join('\n') };
}
