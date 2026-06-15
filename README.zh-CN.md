# hello-cc

<p align="center">
  <img src="assets/logo.svg" width="160" alt="hello-cc logo">
</p>

<p align="center">
  <a href="https://github.com/Dullne/hello-cc"><img src="https://img.shields.io/github/stars/Dullne/hello-cc?style=flat-square&color=40c4aa" alt="GitHub stars"></a>
  <a href="https://www.npmjs.com/package/@logicseek/hello-cc"><img src="https://img.shields.io/npm/v/@logicseek/hello-cc?style=flat-square&color=40c4aa" alt="npm version"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D24.0.0-brightgreen?style=flat-square" alt="node >=24"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue?style=flat-square" alt="license Apache 2.0"></a>
</p>

<p align="center"><a href="README.md">English</a> | <b>中文</b></p>

`hello-cc` 是 Claude Code、Codex 和其他编程 CLI 会话的本地控制平面。它让同一个项目里的终端共享任务板、消息、锁、交接和浏览器控制台，同时保留真实本地终端作为主要交互入口。

<p align="center">
  <img src="assets/screenshots/web-console.png" width="900" alt="hello-cc Web 控制台，展示 agent 会话、任务状态、锁、消息和终端输出">
</p>

<p align="center">
  <em>一个本地 Web 控制台，统一管理 tmux-backed Claude Code、Codex、任务、锁、消息和交接。</em>
</p>

它适合在同一个仓库里同时运行多个 AI 编程 agent 的场景：让它们知道彼此在做什么，而不是各自猜测。

## 特色

- **项目本地共享状态**：peers、tasks、messages、locks、handoffs 和 events 写入 `<project>/.hello-cc/mesh.db`。
- **Web 控制真实终端**：浏览器 attach 到和本地终端相同的 tmux pane，不是浏览器里另开的临时 shell。
- **Claude/Codex 感知项目状态**：hooks 会在模型回答前注入实时 `hcc` 状态。
- **减少编辑冲突**：通过 advisory lock 和 handoff 显式协调多 agent 修改。
- **显式团队拆分**：`hcc team plan/start/status` 可以把一个并行任务拆成可审计
  子任务，不会隐藏地自动启动进程。
- **resume 友好的稳定身份**：当 provider 暴露 session id 时，恢复会话会映射回稳定 peer。
- **一个控制台管理多个项目**：单个本地 Web runtime 可以在多个 project root 之间切换。

## 安装和维护

需要 Node.js 24 或更新版本。

```bash
npm install -g @logicseek/hello-cc
```

更新已有的全局安装：

```bash
hcc update
```

也可以不全局安装，直接运行：

```bash
npx @logicseek/hello-cc web
```

移除本机 hooks 和 shims：

```bash
hcc uninstall
```

移除全局 npm 包：

```bash
npm uninstall -g @logicseek/hello-cc
```

## 快速开始

在需要多个 agent 共享状态的项目中运行：

```bash
cd /path/to/project
hcc web
```

然后打开命令输出里的 URL。默认情况下，`hcc web` 会监听内网地址，请求
`0.0.0.0:8787`，并在 URL 里附带首次自动生成并保存的稳定 token。如果 8787
端口已被占用，且你没有显式传 `--port`，它会自动尝试后续可用端口。启动时会同时
打印内网登录地址和本机 loopback 地址：

```text
open: http://<machine-ip>:8787/?token=<saved-token>&project=/path/to/project
local: http://127.0.0.1:8787/?token=<saved-token>&project=/path/to/project
```

使用 `--local` 可以只绑定 `127.0.0.1`，使用 `--port N` 可以指定请求端口。
`hcc web` 会初始化项目总线，安装 Claude/Codex hooks 和 shims，启动或复用 Web
控制台，然后把终端还给你。

第一次安装 shim 后，打开新终端或重新加载 shell：

```bash
source ~/.bashrc
```

在项目目录中正常启动 agent：

```bash
claude
codex
claude --resume <session-id>
codex resume <session-id>
```

这些会话会成为 tmux-backed peer，可以继续在本地终端里使用，也可以被 Web 控制台观察和操作。

## 基本流程

```bash
hcc task create --title "Review router changes" --priority 20
hcc task next
hcc lock acquire --resource src/router --ttl 900 --reason "edit router"
hcc status
hcc handoff create --summary "Router change ready for review" --tests "npm test"
hcc task done --id 1 --summary "Done"
```

在已接入的 Claude/Codex 会话中可以直接问：

```text
其他 hello-cc 会话现在在做什么？
```

它应该基于实时 `hcc` 状态回答，而不是泛泛地说“会话隔离”。

## 文档

- [文档目录](docs/README.zh-CN.md)：全部用户文档和实现文档入口。
- [用户指南](docs/guide.zh-CN.md)：安装、Web 控制台、协作流程、协作语义和环境变量行为。
- [命令参考](docs/commands.zh-CN.md)：紧凑公共命令清单。
- [更新日志](CHANGELOG.md)：已发布版本的 release notes。

## 测试

```bash
npm test
```

回归测试会创建临时项目、fake Claude/Codex、临时 tmux session 和临时 Web runtime，覆盖主要流程。

## License

[Apache-2.0](LICENSE)

---

<p align="center">
  <a href="https://star-history.com/#Dullne/hello-cc&Date">
    <img src="https://api.star-history.com/svg?repos=Dullne/hello-cc&type=Date" width="600" alt="Star History Chart">
  </a>
</p>
