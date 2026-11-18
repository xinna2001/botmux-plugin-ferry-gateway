# 1.0.0 安装、验证和回退

## 安装

```bash
botmux plugin install @xinna/botmux-plugin-ferry-gateway@1.0.0
botmux plugin service start gateway-acceleration
```

首次在插件管理页准备依赖并完成本人字节内部 SSO。支持 prerequisites 的宿主安装后自动准备 Node.js 和兼容依赖，不需要 npm 生命周期脚本。后台准备不代替本人登录、不获取额外模型权限。

依赖来自内部 registry 的官方 @ad/ferry；仅适配已核验的 0.1.98 / 0.1.120 精确源码，在本机生成私有副本，不改全局上游包。

已有安装原地升级：

```bash
botmux plugin service stop gateway-acceleration
botmux plugin install @xinna/botmux-plugin-ferry-gateway@1.0.0
botmux plugin service start gateway-acceleration
```

提前保密备份配置和私有目录。停止的是管理服务，不是推理进程。不要卸载、清空旧目录或批量杀掉正在回答的会话。

## 验证实际生效

1. 管理弹窗和独立页均须加载 1.0.0 页面与后端；新页面配旧后端不算完成。
2. 进程、SDK、有效认证和模型目录都须通过，不能用“进程在线”冒充就绪。
3. 用真实鼠标、键盘 Space 操作；须同时验证 API、持久化状态、当前 1.0 请求停止加速。
4. 刷新、重开、双页面、迟到 GET 和失败 PUT 不能假装成功或恢复旧开关。
5. 检查实际请求的 controlProtocol/运行代次，不用新默认版本冒充所有会话已升级。明确开启后，受支持的旧话题可在空闲边界迁移到新代次。
6. 真实验证“关闭→原生回复→开启→连续两轮网关回复”、休眠话题无新消息唤醒，以及“关闭期间新建原生话题→开启→实际加速资格”。保留 Botmux 话题 ID、模型、档位和原稿；经验证的历史副本使用新的原生 ID。不重启正在回答或状态不明的任务。
7. 完整自动换线需要宿主提供 `resume-target` 和 `resume-target/prepare` 协议；对应宿主 PR 为 https://github.com/deepcoldy/botmux/pull/3549 。本包不会替用户升级宿主，也不宣称旧版宿主已有该能力。

```bash
botmux plugin list
botmux plugin service status
botmux gateway:status
node "$HOME/.botmux/plugins/gateway-acceleration/dist/bin/status.mjs"
```

不要为只读状态全局启用插件。日志、私有目录可能含内部信息，不公开原始内容或凭据。

## 关闭与重试

关闭会停止已接入 1.0 的加速尝试和定时重试，无输出的加速等待回普通线路；已开始的输出不打断、不重放。旧转发入口和共享网关可继续服务其他会话。

总开关还会为受支持的本地 TraeX 话题提交异步换线请求。跨 provider 只复制可见历史和已完成工具结果，剔除不可移植的加密推理状态，原稿完整保留；ON 从当前最新历史接续。同 provider 代次升级保留推理项。冷恢复仅支持 tmux，活动 PTY/tmux 均需确实空闲；关闭的话题不会复活。Codex 或无同模型原生映射的场景显示限制，不伪装成已完全退出网关。

关闭期间创建的话题，只有显式开启并取得匹配 Bot、话题、目标原生 ID、模型、档位的可信迁移回执后，才获得加速资格。它不改写原快照，也不能越过实时关闭、宿主禁用和手动取消。

Codex 已有网关话题在明确开启后，可通过宿主 `resume-target/park` +
`resume-target/prepare` 在空闲边界保留原生 ID 更新网关代次；需要本地受管 tmux、
已验证完整历史及相同 provider/模型/档位。真实验收须包含 Codex 多轮、工具结果
和更新后的实际请求代次，不以 TraeX 结果代替。该能力不意味着 Codex 已支持
跨 provider 的原生退出。

暂时性失败按 5/15/30 秒追加三次尝试，更长的 Retry-After 优先，不无限重试。控制提示不是模型输出，“正在尝试”不是上游已接受。

自动拒绝冷却有期限；手动取消不自动过期，不被辅助请求或 Bot 总开关清除。首轮恢复需要可信主请求原生身份、原话题绑定及完整回合配置，不猜默认值。

## 连接工具

可下载当前模型的只读本机转发 TOML，不包含个人凭据，不自动启用加速。

端口操作是“核验并切换新话题默认网关”：目标端口实际就绪才提交；占用、认证失败或授权撤销不能显示成功。旧话题仍用原端口，未来运行代次可用独立端口。

## 更新与回退

检查更新只查 FERRY 元数据，独立确认更新才下载和切换；未知版本仍拒绝适配。页面更新的是 FERRY 依赖，不是本插件。

管理适配器按实现内容哈希加载。非常旧的宿主若缓存了旧入口，只重载独立 Dashboard，不因此重启所有 Bot。

回退前确认无任务依赖新代码，保留话题、原生历史、SDK 和运行代次。不能仅覆盖目录就宣称回退完成，也不能让旧版猜测新控制记录。

npm 公开发布、官方目录收录、本机安装、实际服务加载是四件事，分别核验。
