# botmux FERRY 网关插件 0.2.0 安装与升级

这是第三方 Botmux 适配层，不是官方 FERRY 的替代发行版。
支持 npm 包名和经校验的独立 `.tgz` 安装；npm 发布不代表官方目录已收录。

## 新机器

1. 安装官方 Botmux；本版本实机验收为 3.58.0 / macOS arm64。
2. 安装插件：

   ```bash
   botmux plugin install "@xinna/botmux-plugin-ferry-gateway@0.2.0"
   ```

3. 原生“插件”页给所需 Bot 启用“botmux FERRY 网关插件”，不要为方便而全局启用。
   如管理服务未在线，运行 `botmux plugin service start gateway-acceleration`，不需要重启 Bot。
4. 打开插件设置，自动检查运行环境、依赖、内部登录三项。
   已有兼容依赖及本人登录会复用；缺失项点击“一键补足”或“本人登录”。
   浏览器登录返回后自动刷新，三项就绪后点击“完成配置”。
5. 页面按 Bot 实际 CLI 显示模型和控制；先选支持当前推理档位的固定 GPT 模型，再按需加速。

包安装本身不自动安装 FERRY。依赖补足使用内部 registry
`https://bnpm.byted.org` 上官方 `@ad/ferry@0.1.98`，不会覆盖全局安装或执行 npm 安装脚本。
需要用户自己的内网访问权限和内部账号；把这个 npm 包发给别人不等于给对方开权限。

如果使用发布者给出的 `.tgz` 下载地址，可将同一个安装命令中的 npm 包名替换为该 URL。
先核对发布者提供的 SHA-256；不要运行来源不明的 `curl | sh`。

## 模型与两个开关

- Codex：选择 FERRY GPT 模型会接通模型转发，加速默认关闭。
  关闭加速不关闭转发，不改变所选模型。
  关闭转发不会把 FERRY 模型偷偷换成原生模型；新的会话需自行选原生模型或重新开转发。
- TraeX：模型目录取原生 GPT/Standard/Max 与 FERRY 的交集，只有加速开关。
  加速关闭时新会话原生运行，开启时用同模型及已核验档位。
- 档位不支持时先在 Botmux 的 Bot 设置中调整，插件不自动降档。
- 自动选模池需先关闭；非 GPT、未知 wrapper、隔离/远端等未适配启动方式会明确拒绝。
- 正在运行的会话不迁移；恢复历史保留原 provider。无法确认历史 provider 时拒绝恢复，
  不删除、不改写历史文件。老入口及其运行时不要删除。

## 目录与升级

- 插件：`~/.botmux/plugins/gateway-acceleration/`
- 注册：`~/.botmux/plugins-registry.json`
- Bot 设置：`~/.botmux/bots.json`，全局设置：`~/.botmux/config.json`
- 插件配置与私有数据：插件目录内的 `config.json`、`private/`
- 按需补足的官方依赖：`~/.botmux/local/ferry-plugin-dependency/`
- 管理端口：18739；新受管 FERRY 默认端口：18790。

升级前保密备份上述配置、私有数据及原有运行目录。不要把备份作为分享包上传。
对**同一个插件 ID 原地安装新包**；不要先卸载，不要删除 `private/`，
不要变更 Bot ID、已有模型或启用范围。正常升级 Botmux 程序不需要重新找包，
但目标版本仍须先做插件兼容性验收。换机器、清空 HOME、卸载插件不属于正常原地升级。

Botmux 要求更新前先停止插件管理服务；这不停止独立推理进程：

```bash
botmux plugin service stop gateway-acceleration
botmux plugin install "@xinna/botmux-plugin-ferry-gateway@0.2.0"
botmux plugin service start gateway-acceleration
```

无需重新执行 enable，以免意外扩大原有按 Bot 的启用范围。
使用独立安装包时，可将安装参数替换为经校验的下载 URL 或 `file:/absolute/path/xinna-botmux-plugin-ferry-gateway-0.2.0.tgz`。

本适配固定核验 FERRY 0.1.98 的源码哈希。全局已安装新版本时不会自动降级它，
可经用户点击补足独立兼容版本。升级上游 FERRY 或原生客户端前先验证；
不应把“插件目录还在”解释为“所有新版本都兼容”。

回退时先关闭新会话的加速；保留历史 provider 所需入口及私有数据。
不要直接将 0.2.0 的配置交给不认识新控制记录的旧插件。恢复备份前应先确认没有
依赖新入口的活跃会话；不要为回退强制取消他人的任务。

## 状态检查

```bash
botmux plugin list
botmux plugin service status
node "$HOME/.botmux/plugins/gateway-acceleration/dist/bin/status.mjs"
```

如 CLI 命令发现受逐 Bot 启用范围限制，使用上面的只读入口，不要因此改成全局启用。
日志可能含内部服务信息，只在本机排查，分享前脱敏。
安装包不含内部 FERRY 源码、个人登录态或 Bot 凭据。
