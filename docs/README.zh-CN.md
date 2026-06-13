# hello-cc 文档

只需要项目简介和第一条命令时，先看[仓库 README](../README.zh-CN.md)。
需要更多细节时，再看下面的文档。

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
