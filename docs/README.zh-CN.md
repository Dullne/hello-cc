# hello-cc 文档

只需要项目简介和第一条命令时，先看[仓库 README](../README.zh-CN.md)。
需要更多细节时，再看下面的文档。

1.0.0 是 breaking release：schema v7 不支持降级，迁移前会生成并校验备份；
provider peer ID 已变更且不会映射旧 ID；受保护接口使用 Runtime API v2。存活由
进程证据决定，只有 unknown 证据获得 120 秒宽限；`gc --history` 必须显式启用。
可以直接使用 `--tls`，或让 `--trust-proxy` 固定 `--proxy-origin`。默认可信内网明文监听，以及已认证
浏览器可选择服务器上任意已存在目录，是明确接受的风险。

## 用户文档

- [用户指南](guide.zh-CN.md)：安装、启动、Web 控制台、协作语义、工作流、稳定
  peer 身份和环境变量行为。
- [命令参考](commands.zh-CN.md)：公共命令的紧凑清单，以及每组命令的用途。
- [项目目录身份与私有状态](private-state.zh-CN.md)：状态位置、v2 分代、冷停机
  迁移回执、暂停新启动和 Codex 历史身份。
- [DeepSeek Harness 接入](dsh.zh-CN.md)：项目配置、hooks/Cordis 协作、ACP worker、
  可安装 bundle 与会话路由边界。
- [Native 后台 worker](native.zh-CN.md)：后台 worker 所有权、provider adapter、
  投递回执、权限处理和 resume 边界。
- [更新日志](../CHANGELOG.md)：已发布版本的 release notes。
- 发行说明：发布前运行 `npm run release:check` 和
  `npm run release:github:dry-run`。推送 `v*` tag 会触发
  `.github/workflows/github-release.yml`，根据当前 changelog 小节创建或更新
  GitHub Release 描述。旧版本可用 `workflow_dispatch` 补写描述，不需要个人
  token。

## 设计和实现

- DeepSeek Harness 接入计划 (源码目录: `docs/plans/2026-10-02-dsh-integration.md`)：三个实现阶段、模块契约与完成门槛。
- DeepSeek Harness 验收 (源码目录: `docs/verification/2026-10-02-dsh-cordis-native.md`)：真实模型、包加载、回归与浏览器证据。

- [Web 接手本地任务](web-handoff.zh-CN.md)：控制租约、草稿恢复、暂停接管、Codex App Server 与历史交接边界。
- [MCP 协作工具](mcp.zh-CN.md)：固定项目、peer 与执行器身份的任务、消息、锁和结果证据工具。
- [设计说明](design.md)：产品边界、项目边界、能力层级、协作语义和 provider
  session 绑定。
- [实现说明](implementation.md)：架构、协议、命令面、技术栈、shim 行为和实现计划。
- [架构设计](architecture.zh-CN.md)：目标目录结构、模块边界、依赖方向和分阶段
  迁移计划。

`design.md` 和 `implementation.md` 目前只有英文版。

- [桌面 Agent 通信](app-bridge.zh-CN.md)：DSH 空闲唤醒、Codex 会话内收发与只读端点检查，以及可选的 Claude Desktop Mod。
