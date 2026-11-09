# FERRY 网关

第三方 Botmux 适配插件 `0.2.0`，仅限已有内部 FERRY 权限的用户。

```bash
botmux plugin install @xinna/botmux-plugin-ferry-gateway@0.2.0
```

在原生插件页为指定 Bot 启用，打开设置完成三项自动检查。
Codex 提供固定 GPT 模型选择、独立的“模型转发”和“同模型加速”；
TraeX 按原生模型及 Standard/Max 能力匹配，只显示“同模型加速”。
不支持非 GPT、自动选模池或未知启动封装，不自动换模型或降档。

本包不是重新发布 FERRY，也不携带登录信息。优先复用兼容安装；缺失时经用户点击
从内网安装官方 `@ad/ferry@0.1.98`，本人完成内部登录。
通过版本/文件哈希核验后在本机生成私有受管副本，不修改或公开上游文件。
未知 FERRY 版本拒绝适配。

实机验证：macOS arm64、Botmux 3.58.0、Node.js 24.16.0、
Codex 0.166.0、TraeX 0.213.1。其他环境需先验收。
加速仍可能排队；旧会话保留原 provider 和入口，不会因开关被中断。

详见 [安装说明](INSTALL.zh-CN.md) 和
[源码、兼容边界与测试说明](https://github.com/xinna2001/botmux-plugin-ferry-gateway)。
