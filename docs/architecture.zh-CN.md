# hello-cc 架构设计

日期：2026-06-14

本文定义 hello-cc 的目标模块布局。它是后续重构的设计目标，不表示当前所有文件
都已经符合这个结构。

目标是停止按 helper 大小拆代码，改为按产品边界移动代码。薄 CLI、明确的核心
状态模型、独立 runtime 层、terminal adapter 和 Web server 边界，能让后续修改
更容易审查，也更不容易把无关行为混在一起。

## 参考结构

成熟的 agent CLI 项目通常采用类似分层：

- 入口文件保持很薄，只转发到 command 或 server 模块；
- 核心协作逻辑不依赖 HTTP、tmux 或进程启动细节；
- runtime 文件和 runtime client 独立于命令处理器；
- Web server routes、WebSocket transport、session lifecycle 是明确的 server
  模块；
- provider 特有行为与通用 session/task 逻辑隔离；
- 测试按领域分组，而不是一直追加到一个巨大脚本里。

Codex 这类结构会把 `cli`、`core`、`app-server`、`protocol` 或 transport、state
store、hooks、config、execution adapter 分开。hello-cc 不需要 Rust crate，也
不需要同样规模，但应该采用同一个架构原则：按边界拆，不按顺手程度拆。

## 当前压力点

当前代码已经抽出了很多聚焦模块，例如 schema、runtime state、task/message
store、peer identity、provider command builder、tmux helper、Web HTTP helper
和 render helper。

剩余结构压力主要在：

- `bin/hcc.mjs` 仍包含 command dispatch、command handler、Web server setup、
  HTTP routes、WebSocket terminal、tmux session 管理、PTY session 管理、
  external buffer adoption 和 shutdown cleanup。
- `cmdWeb()` 是最大的混合边界。它应该被视为 Web runtime 子系统，而不是普通
  CLI command body。
- `scripts/regression.mjs` 是有价值的全量回归入口，但后续应该变成一个调用领域
  regression module 的 runner。

## 目标目录

```text
bin/
  hcc.mjs

lib/
  cli/
    dispatch.mjs
    context.mjs
    commands/
      ask.mjs
      broadcast.mjs
      down.mjs
      event.mjs
      gc.mjs
      handoff.mjs
      hooks.mjs
      init.mjs
      inject.mjs
      join.mjs
      lock.mjs
      msg.mjs
      peer.mjs
      prompt.mjs
      run.mjs
      scan.mjs
      setup.mjs
      shim.mjs
      state.mjs
      status.mjs
      task.mjs
      team.mjs
      uninstall.mjs
      update.mjs
      up.mjs
      web.mjs

  core/
    coordination/
      automation.mjs
      handoff.mjs
      locks.mjs
      messages.mjs
      tasks.mjs
      teams.mjs
      timeline.mjs
    peers/
      bindings.mjs
      format.mjs
      identity.mjs
      liveness.mjs
    sessions/
      launch.mjs
      model.mjs
      providers.mjs
      serialization.mjs

  db/
    connection.mjs
    migrations.mjs
    schema.mjs
    stores/
      locks.mjs
      messages.mjs
      peers.mjs
      tasks.mjs

  runtime/
    client.mjs
    paths.mjs
    projects.mjs
    state.mjs

  terminal/
    external-buffer.mjs
    pty.mjs
    tmux-stream.mjs
    tmux.mjs

  web/
    projects.mjs
    routes.mjs
    server.mjs
    session-manager.mjs
    websocket.mjs
    http.mjs
    ui-template.mjs

  integrations/
    hooks/
      claude.mjs
      codex.mjs
    providers/
      claude.mjs
      codex.mjs
      shell.mjs
    shims/
      setup.mjs
      script.mjs

  ui/
    format.mjs
    help.mjs
    state-render.mjs

  release/
    package-meta.mjs
    release-notes.mjs

  shared/
    errors.mjs
    json-file.mjs
    text.mjs

scripts/
  regression.mjs
  regression/
    cli.mjs
    coordination.mjs
    db.mjs
    release.mjs
    runtime.mjs
    sessions.mjs
    web.mjs
```

## 边界规则

`bin/hcc.mjs` 应该变成很薄的入口。它可以解析全局参数、创建 root context、调用
dispatch，并把顶层错误转换为 CLI 输出。它不应该拥有 Web routing、DB schema、
tmux streaming、provider command construction 或 task state machine。

`lib/cli/` 负责命令解析和命令处理器。命令处理器可以打开数据库、调用 store 或
core service，并打印结果。当逻辑可以放进 `core`、`runtime`、`terminal`、`web`
或 `integrations` 时，不应该留在 command handler 里。

`lib/core/` 负责产品语义。task lifecycle、takeover readiness、message thread、
lock conflict rule、team planning、peer identity semantics 和 session identity
rule 属于这里。core module 不应该依赖 HTTP request、WebSocket、tmux command 或
process spawning。

`lib/db/` 负责 SQLite connection、schema、migration 和 data store。store module
应该暴露明确操作和事务边界。schema migration 必须能安全迁移每个注册项目数据库，
而不只是当前项目。

`lib/runtime/` 负责 runtime file、runtime discovery、runtime client request 和
project registry state。它不应该知道 Web route 如何渲染 UI，也不应该知道
terminal byte 如何传输。

`lib/terminal/` 负责 terminal adapter。tmux pane inspection、tmux stream setup、
tmux input、PTY spawn 和 external buffer adoption 属于这里。terminal adapter
可以发出 session event，但不应该决定 task ownership 或 message 行为。

`lib/web/` 负责 Web runtime。它应该组装 project context、session manager、HTTP
route、WebSocket terminal upgrade 和 shutdown cleanup。route handler 应该很薄，
并委托给 store、core service、runtime module 或 terminal/session manager。

`lib/integrations/` 负责 provider 特有行为。Claude、Codex、shell command
construction、hook installation details 和 shim script 不应混入通用 session 和
coordination module。

`lib/ui/` 负责 CLI 文本输出和 help。它可以格式化已经计算好的状态，但不应该读取
或修改项目状态。

`lib/release/` 负责 release metadata 和 release notes helper。release script 和
GitHub release 工具应共享这里的 helper。

`lib/shared/` 只放少量低依赖通用工具，不能变成新的杂物箱。

## 包发布面策略

受支持的公共接口是安装后的 CLI：`hcc` 和 `hello-cc`。`package.json` 包含
`lib/` 是因为 CLI 运行时会 import 这些文件，不表示每个 `lib/*` 路径都是稳定
library API。

不要在用户文档里新增 `@logicseek/hello-cc/lib/*` 这类导入用法。主实现应该放在
目标产品目录里；顶层 `lib/*.mjs` 文件只有在有明确兼容理由时，才作为
compatibility entrypoint 保留。

`@logicseek/hello-cc@0.1.5` 已经从 git head `4969100` 发布。这个已发布包因为
没有定义 `exports` map，已经暴露了一些顶层 `lib/*.mjs` helper 路径。常规 cleanup
提交里不要删除或重命名这些已发布路径；除非项目明确选择破坏性 package surface
变更，否则至少保留一个 release cycle，作为 compatibility re-export。

对于 `0.1.5` 之后的本地迁移提交，默认不要继续增加顶层 compatibility shim。如果
某个尚未发布的顶层 shim 要保留到下一版，需要在 release notes 里说明它只是
compatibility-only，并在再下一版前重新评估是否删除。不要让 compatibility shim
变成目标架构。

发行前，把顶层 `lib/*.mjs` 路径分成三类：

- A 类：已发布过，或 CLI 面向用户需要稳定的 helper 路径，本次发行必须保留。
- B 类：目录迁移产生的 compatibility path，只是 re-export 已移动实现；如确有
  需要可保留一个版本，但 release notes 要说明它只是 compatibility-only 的
  deep-import 路径。
- C 类：尚未发布、内部也不用、没有兼容价值的 shim，发布前删除。

因为 npm 上已经存在 `0.1.5`，任何包含 `4969100` 之后本地提交的发行都必须使用新
package 版本。不要尝试重新发布 `0.1.5`。

## 依赖方向

目标依赖方向：

```text
bin -> cli -> web/runtime/db/core/terminal/integrations/ui
web -> runtime/db/core/terminal/ui
terminal -> shared/core sessions only when needed
core -> shared
db -> shared
ui -> shared
release -> shared
```

避免以下依赖：

- `core` import `web`、`terminal`、`cli` 或 `integrations`；
- `db` import `cli` 或 `web`；
- `terminal` import Web route module；
- provider integration import command handler；
- `shared` import 产品特定模块。

这样大多数行为可以在没有 Web runtime 或 tmux process 的情况下测试。

## 迁移计划

重构必须小步进行，每一步都保持公共行为和 npm package 内容稳定，除非任务明确要
改行为。

1. 写下目标架构。
   本文就是后续拆分的合同。

2. 把现有平铺模块移动到目标目录。
   先做低风险迁移，例如 `runtime-*`、`web-*`、`task-store`、`messages`、`help`、
   `state-render` 和 release helper。如果 import churn 太大，可以临时保留
   compatibility re-export 文件。

3. 按子系统拆 Web runtime。
   分提交从 `cmdWeb()` 抽出 project selection、session manager、Web routes、
   WebSocket terminal、tmux stream、PTY session 和 external buffer adoption。

4. 让 `bin/hcc.mjs` 变成薄入口。
   把 dispatch 和 command groups 移到 `lib/cli/commands/`。

5. 按领域拆 regression。
   保持 `npm test` 是唯一全量回归命令，但让它调用 `scripts/regression/` 下的
   领域模块。

## Web Runtime 目标

最有价值的 runtime 拆分如下：

```text
lib/web/server.mjs
  createWebRuntime(ctx, opts, deps)
  start/stop lifecycle

lib/web/projects.mjs
  rememberProject()
  knownProjects()
  projectFromRequest()

lib/web/session-manager.mjs
  sessions map
  getSession()
  serializeSession()
  startSession()
  stopSession()
  restoreManagedSessions()

lib/web/routes.mjs
  routeHttpRequest(req, res, env)

lib/web/websocket.mjs
  handleTerminalUpgrade(req, socket, head, env)

lib/terminal/tmux-stream.mjs
  startTmuxStream()
  stopTmuxStream()
  refreshTmuxSnapshot()

lib/terminal/external-buffer.mjs
  adoptExternalSession()
  scanExternalSessions()
```

这个拆分能让 Web 空白、stale session、tmux stream 和 provider binding 问题更
容易定位。

## 测试要求

每个结构迁移任务至少运行：

```bash
git diff --check
node --check bin/hcc.mjs
node --check <changed modules>
npm test
```

涉及发行面的变更还要运行：

```bash
npm run release:check
npm run release:github:dry-run
npm pack --dry-run --json
```

新增 `lib/` 模块后，要确认 `npm pack --dry-run --json` 包含它们。

## 非目标

不要在本次布局迁移中引入 TypeScript、Rust、bundler 或 build step。这些都是单独
的产品决策，会影响 release 和安装成本。

不要在移动文件时重写已工作的行为。目录迁移提交应该很朴素：import 改了、模块
路径改了、regression guard 改了，但行为不变。

在没有单独 Web UI build 方案前，不要把 UI template asset 移到前端框架里。当前
npm 包安装后应继续可以直接运行。
