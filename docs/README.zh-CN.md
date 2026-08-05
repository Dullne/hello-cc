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
- [更新日志](../CHANGELOG.md)：已发布版本的 release notes。
- 发行说明：发布前运行 `npm run release:check` 和
  `npm run release:github:dry-run`。推送 `v*` tag 会触发
  `.github/workflows/github-release.yml`，根据当前 changelog 小节创建或更新
  GitHub Release 描述。旧版本可用 `workflow_dispatch` 补写描述，不需要个人
  token。

## 设计和实现

- [设计说明](design.md)：产品边界、项目边界、能力层级、协作语义和 provider
  session 绑定。
- [实现说明](implementation.md)：架构、协议、命令面、技术栈、shim 行为和实现计划。
- [架构设计](architecture.zh-CN.md)：目标目录结构、模块边界、依赖方向和分阶段
  迁移计划。

`design.md` 和 `implementation.md` 目前只有英文版。
