# Botmux FERRY 网关插件 1.0

为已授权的固定 GPT 模型提供同模型加速、有限重试和会话线路沿用。仅限有相应内部服务权限的用户；不包含上游 FERRY 程序、个人配置或凭据。

```bash
botmux plugin service stop gateway-acceleration
botmux plugin install @xinna/botmux-plugin-ferry-gateway@1.0.0
botmux plugin service start gateway-acceleration
```

- 初次尝试失败后最多追加 5 / 15 / 30 秒三次重试，尊重更长的 Retry-After；实际输出后不重放。
- 实际加速返回后，同一会话后续请求沿用线路；区分尝试、接受、失败，不反复假称新一次加速。
- 识别 Codex 标题、系统、子任务等辅助请求，不能抢占主任务状态或改变父任务控制。
- 关闭实时生效；已有回答和工具不强断。受支持的旧话题通过精确历史/身份校验异步切换。
- TraeX 支持经授权的可见历史副本换绑；Codex 支持保留原生 ID 的同 provider 网关代次更新。

## 使用与兼容

[完整功能和边界](gateway/README.md) · [安装、验收与回退](gateway/INSTALL.zh-CN.md)

精确验证 FERRY 0.1.98 / 0.1.120 的源码身份。未知版本拒绝适配，不自动换模型、降档、扩大上下文或开启超频。

完整旧话题管理需要宿主的 `resume-target`、`prepare`、`park` 管理协议，见 [宿主 PR #3549](https://github.com/deepcoldy/botmux/pull/3549)。插件安装不会升级 Botmux；无此能力的宿主不能宣称完整迁移。没有同模型原生等价的 Codex FERRY 专属模型，不能伪装成已退出网关。

加速仍受上游容量、网络、额度与权限影响，不保证零排队。

## 开发与发布验证

```bash
npm ci --ignore-scripts
npm run build
npm test
npm run test:package
```

`gateway/dist` 是安装运行单元，不保留工作区 `node_modules`。`gateway` 包的 `prepublishOnly` 会重新构建、测试并校验 tarball。

原生双版本循环测试需要合法取得的上游源码，分别通过 `FERRY_TEST_098_PACKAGE`、`FERRY_TEST_120_PACKAGE` 指定目录；不将上游源码纳入本仓库。真实浏览器、客户端和模型验收与隔离单测分别记录，发布时核对实际 tarball 的 SHA-256 / integrity，不把 fixture PASS 当作生产可用证明。
