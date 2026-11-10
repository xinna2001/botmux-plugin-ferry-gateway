# botmux FERRY 网关插件

第三方实验版本 `0.2.0`，仅面向已有内部 FERRY 使用权限的用户，不是 FERRY 或 Botmux 官方发行版。

npm 包为 [`@xinna/botmux-plugin-ferry-gateway`](https://www.npmjs.com/package/@xinna/botmux-plugin-ferry-gateway)。
npm 发布与官方目录收录相互独立；目录状态以实际登记 PR 为准，不以 Issue 代替。

本 npm 包是 **Botmux 适配层**，不是重新发布 FERRY。它不包含 `@ad/ferry` 的实现、
用户凭据或个人 Bot 配置。优先复用本机兼容的上游安装；缺少依赖时，用户在设置页
点击“一键补足”，才从内部 registry 安装官方 `@ad/ferry@0.1.98` 到独立私有目录。
不会静默安装、替换全局 FERRY、复制他人登录态或授予内部权限。

## 安装

```bash
botmux plugin install "@xinna/botmux-plugin-ferry-gateway@0.2.0"
```

在原生“插件”页为需要的 Bot 启用“botmux FERRY 网关插件”，打开插件设置。
安装后首次配置自动显示三项检查：运行环境、依赖、内部登录；不需要选择 Bot。
缺失项提供明确的一键操作，登录后回到页面自动刷新。
这是插件设置页，不替换官方市场的安装确认流程。

完整操作和升级/回退边界见 [安装说明](gateway/INSTALL.zh-CN.md)。
也可使用发布者提供并经 SHA-256 校验的 `.tgz` 下载 URL，或 `file:/absolute/path/xinna-botmux-plugin-ferry-gateway-0.2.0.tgz`。

## 控制行为

| 实际 Bot 架构 | 模型选择 | 控制 |
| --- | --- | --- |
| Codex | FERRY 返回的固定 GPT 模型 ID | 模型转发、同模型加速分别控制 |
| TraeX | 原生 GPT 名称、Standard/Max 与 FERRY 目录交集 | 仅同模型加速，不显示转发开关 |

- 架构取自 Bot 的 `cliId`，不根据 Bot 名称猜测。
- 选择 Codex 的 FERRY 模型会明确开启转发，但不自动开启加速。
- 关闭加速不会关闭转发或切换模型。加速开启时需先关闭加速，才能关闭转发或换模型。
- Codex 关闭转发后，仍保留 FERRY 模型名；新会话须重新开转发或手动选择原生模型，
  不会偷偷换一个 GPT。旧 FERRY 会话保留原 provider。
- TraeX 关闭加速后，新会话走原生客户端；开启后使用核验过的同一模型和档位。
- Max 上下文取原生与 FERRY 能力的较小值，例如已验证的 TraeX GPT-6.1-Sol Max 为 800K，
  不把上游 1M 直接套用到原生 800K 配置。
- 非 GPT、自动选模池、不支持的档位、未知 wrapper 和无法核验的会话 provider 均拒绝，
  不做自动降档、换模型或 provider 迁移。
- 已开始输出的请求不会为加速而重试；队列调整仅针对同模型、输出前、有限的一次机会。
  不承诺零排队，也不保证每次更快。
- 日常页面不显示请求计数器或历史请求表。

## 兼容范围

实机验证：macOS arm64、Botmux **3.58.0**、Node.js **24.16.0**、
Codex **0.166.0**、TraeX **0.213.1**、FERRY **0.1.98**。
运行环境要求 Node.js 22+；其他系统/客户端版本尚未完成同等实机验收。
额外 wrapper、远程后端、读隔离、文件沙盒、触发用户身份隔离、
外部 app-server/实例池暂不自动接管。插件不关闭这些保护来换取兼容。

上游 FERRY 尚无满足这些控制语义的稳定公开接口，因此本版本在目标机器上核验
官方 `dist/cli.js` 的版本及 SHA-256，用 AST 生成**私有受管副本**并接入插件自身策略；
不修改原文件，不把该副本发布到 npm。上游文件或结构不匹配即拒绝启动，
不会尝试适配未知版本。此方案具有明确的版本维护成本，不是通用 FERRY SDK。

管理服务端口默认 `18739`，新受管推理实例默认 `18790`。
旧网关继续由原来的 supervisor 管理；插件不会抢占旧端口、停止旧进程或取消在途请求。
配置成功后管理服务可恢复自己管理的实例；停止管理服务不会停止在途推理实例。

## 验证

```bash
npm ci --ignore-scripts
npm run build
npm test
npm run test:package
npx playwright install chromium
npm run test:browser
```

单元测试使用临时目录；包测试真实打包、解压并在隔离 HOME 加载。
浏览器测试使用隔离的真实配置文件与模拟运行时，验证三项检查、模型落盘、两个架构的
开关、桌面/手机布局；它不是生产环境的端到端测试。

另已在隔离配置中用真实 Codex/TraeX 完成 `initialize`、`model/list`、`thread/start`
及 GPT 请求，两个客户端均返回预期的 `OK`，策略记录保持原模型、medium 档位。
这些请求没有排队，因此真实队列换路尚未被该次实机测试覆盖；换路/禁止输出后重试
由确定性策略测试覆盖。没有为了验收修改生产 Bot 或生产历史。

## 升级与数据

包安装到 `~/.botmux/plugins/gateway-acceleration/`，不链接开发源码目录。
Botmux 正常原地升级不会把用户插件视为其程序安装文件；插件注册记录、按 Bot 启用范围、
配置及私有运行数据应保留。**保留不等于兼容新版本**：跨出上述验证范围前，先备份并验收。
不要通过“卸载再安装”来升级；不要直接删除私有目录，旧会话可能仍依赖其中的入口或模型目录。

## 官方文档与目录

- [插件开发/发布文档](https://github.com/deepcoldy/botmux/blob/master/docs-site/docs/zh/plugins.md)
- [官方插件目录](https://github.com/botmux-ai/plugin-market)

目录仓库只接收 npm 包元数据，不接收插件实现。提交 PR 不代表已合并、官方维护或安全背书。
旧 `installation/` 目录保留独立安装协调器实验，不是已注册的官方安装前钩子。
