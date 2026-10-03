# DeepSeek Harness 实际 Mac 接入验收

日期：2026-10-02。系统：macOS arm64。官方应用：/Applications/DeepSeek Harness.app，版本 0.2.0-rc.2；内置 Node v24.18.1，CLI Node v24.19.0。

后续更新：2026-10-03 已安装 1.0.2-dsh.3，桌面需要重启激活；本记录保留首次接入快照。详见 [最终验收](2026-10-03-dsh-preview-final.md)。

## 已完成的实际接入

- 通过官方插件管理服务向 ~/.dsh/profiles/desktop 安装经 SHA256 校验的候选包。返回 application=applied、warnings=[]；hello-cc 插件 fiberPhase=active，桌面插件列表显示已启用。
- 原生构建仅允许 node-pty@1.2.0-beta.15。备份原 profile 的 package.json、cordis.patch.yml、pnpm-workspace.yaml；凭据只保留摘要，没有复制或输出密钥。
- /opt/homebrew/bin/dsh 链接至已安装官方 Desktop CLI；/opt/homebrew/bin/hcc-dsh 为候选安装包的专用 CLI。原有 /opt/homebrew/bin/hcc 是工作区开发链接，保留该链接。
- 新建专用 Desktop 验收会话，验证 exact cwd、完整 provider session ID 与 Cordis peer binding。既有三个会话保留。
- 使用实际官方 Desktop CLI、真实用户 ACP profile 和安装包 CLI完成真实 DeepSeek 协作：hcc_state、hcc_message_send、主动消息、模型回复、completed delivery、唯一 ACK。该 worker 和其 native 服务已经关闭。
- 补修 setup 从源码目录迁移到安装包目录的误判；新增迁移、编辑保护和缺失 overlay 恢复三项测试。

## 桌面模型路由的实际结果

新建会话沿用原配置 sub2api / gpt-6.1-sol。实际模型回合返回 HTTP 403，原文为 “This account only allows Codex official clients”。此回合没有执行 hcc 工具，因此不能计为桌面模型工具验收通过。没有调整该账户、网关限制、默认模型或凭据。后续核对发现，桌面默认模型已在运行期间变为 deepseek-official / deepseek-flash / max；本验收没有调用 selectModel 或 initializeDefaultModel，也没有回滚该新选择。沿用当时默认配置新建验收会话，真实调用 hcc_state、hcc_message_send，数据库核对 sender 与完整会话身份一致，turn/end=completed。原 sub2api 路由的 403 并未修复。

初次失败会话以“hello-cc 桌面接入验收（默认模型 403）”保留；成功会话为“hello-cc 桌面接入验收（通过）”。均为专用测试目录内的会话，现已 idle。原有三个会话保留；凭据摘要保持一致。

## 发布与业务边界

npm 公开 1.0.1 包含 158 个文件，没有 dsh/native 实现。npm whoami 返回 401，尚无可用发布权限。1.0.2-dsh.1 预览候选已完成 npm publish dry-run、隔离安装 8/8 和实际安装 CLI 的 ACP 恢复记忆验收；当前工作区 867 项测试、866 通过、1 项平台跳过，63 项 factory 审计和 13 步回归通过。计划使用 dsh dist-tag；本地候选包含接入依赖的 native/MCP/Web 代码，以冻结文件清单为范围，不从当前混合工作树直接发布。尚未完成 npm 发布、其他 Mac/Linux/WSL 设备验收和真实业务签收；原生 Windows shell 不受支持。上述测试数字为 2026-10-02 的工作区快照，不代表后续工作区变更均已验收。

## 持久证据

本机证据目录：/Users/xf02163/Documents/Codex/artifacts/dsh-integration-2026-10-02/device。交付入口：/Users/xf02163/Documents/Codex/artifacts/dsh-integration-2026-10-02/DELIVERY.md。包含 profile 备份、安装结果、源文件摘要、默认模型 403 事件、ACP 真实完成结果和关闭回执。发布目录为同一交付根目录的 release 子目录。
