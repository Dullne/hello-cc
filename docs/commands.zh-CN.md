# hello-cc 命令参考

使用 `hcc --help` 查看当前顶层命令列表。大多数子命令也支持 `--help`，
例如 `hcc update --help`、`hcc peer --help` 和 `hcc task --help`。

1.0.0 使用 schema v7（不支持降级）、经校验的迁移前备份、不会映射旧 ID 的
完整 session provider peer ID，以及 Runtime API v2。进程证据决定存活，只有
unknown 证据获得 120 秒宽限；历史清理必须显式使用 `gc --history`。默认可信
内网明文监听和已认证浏览器访问任意已存在服务器目录，是明确接受的风险。

## 安装维护

```text
hcc update [--tag TAG] [--registry URL] [--dry-run]
hcc uninstall [--purge --yes]
```

`hcc update` 更新全局 npm 安装。`hcc uninstall` 移除本机 hooks、shims 和 shell PATH 配置；
只有在确定也要删除当前项目的 `.hello-cc` 数据和指导块时，才加
`--purge --yes`。

## 离线状态迁移

```text
hcc --root DIR migrate-state --offline --yes
hcc --root DIR --json migrate-state --inspect-private-binding
hcc --root DIR migrate-state --upgrade-private-binding --offline --yes --assert-historical-root --expect-receipt=SHA256
```

第一条命令将保留的项目局部状态制作快照，迁入私有目录。后两条用于检查并
明确升级已有私有 v1 目录绑定。升级前独立核实历史根目录、备份状态，并停止
全部写入者；检查回执不证明当前目录就是历史根。发布中断时保留封锁标记，
经核实的重试完成后才恢复访问。恢复边界、v2 替换目录分代和
`HCC_PINNED_LAUNCH_MODE=hold` 见[项目目录身份与私有状态](private-state.zh-CN.md)。

## 只读诊断

```text
hcc doctor [--codex] [--json]
```

默认只检查项目数据库完整性和 schema 兼容性；损坏或不支持的 schema 返回非零退出码。
加 `--codex` 才执行有时限和输出大小限制的 `codex --version`、`codex app-server --help`，
两个探测使用临时 HOME/CODEX_HOME 并清理启动文件；hooks 检查读取原 Codex home 的
`hooks.json` 并查看本项目已有 hook 调用事件。help 只能证明
启动参数被声明，不能证明协议握手或模型可用；hook 配置存在、历史调用记录、stdout 投递
和 provider 接收分别报告。当前无明确 stdout 回执，投递、接收和 trust 均保持 `unknown`。
诊断不启动模型或会话、不执行 hooks，不修改账号、信任或 shim；可选诊断未知不会使健康
数据库返回失败。`--json` 在现有报告中增加 `data.codex`，默认报告结构不变。

## 启动和停止

```text
hcc web [--host HOST] [--port N] [--token TEXT] [--local] [--tls] [--trust-proxy --proxy-origin ORIGIN] [--no-token] [--no-discover] [--no-guidance]
hcc down
hcc up [--no-discover] [--no-guidance]
```

`hcc web` 是默认入口。它会初始化协作状态，安装 hooks 和 shims，启动或复用
Web 控制台，然后把终端还给你。裸 `hcc web` 会监听 `0.0.0.0`，并为本次
runtime 生成 URL token。用 `--local` 可只绑定 `127.0.0.1`，用 `--token` 或
`HCC_WEB_TOKEN` 可设置显式 token；私有 HTTPS Runtime API CA 用
`HCC_RUNTIME_CA` 指定。只有在可信本地/测试环境才使用 `--no-token`。
只想使用本地协作、不需要 Web 或 shims 时，再使用 `hcc up`。provider shim 只会加入
已经由 `hcc web` 生成本地 `.hello-cc/runtime.json` 的项目，不会使用全局 runtime
去管理任意目录。

同一浏览器可以登录同一主机上不同监听端口的多个 Web 实例，刷新或退出其中
一个不会覆盖另一个的登录。Cookie 按协议与实际监听端口命名；可信反向代理
使用固定 `--proxy-origin` 的协议与端口。升级后需重新登录，旧版 Cookie 不会
被复用或清除。这用于避免实例间的意外覆盖，不是浏览器安全隔离边界。
若多个 SSH 隧道把相同的远端监听端口映射到不同本地端口，应使用独立浏览器
配置文件或不同主机名；服务端无法从直连配置识别此端口映射。

## Native 后台 worker

```text
hcc native up
hcc native start --peer NAME --provider codex|claude|dsh [--cwd DIR] [--model MODEL] [--binary PATH] [--resume last]
hcc native send --peer NAME --body TEXT [--from NAME] [--task ID]
hcc native status
hcc native deliveries [--peer NAME]
hcc native events --peer NAME [--after ID]
hcc native requests --peer NAME
hcc native respond --peer NAME --request ID --decision accept|decline|cancel [--response-file JSON]
hcc native interrupt --peer NAME [--turn ID]
hcc native close --peer NAME
hcc native down
```

这些命令通过 Codex app-server、可选 Claude Agent SDK 或 dsh ACP 管理 HCC 持有的
后台 worker。send 成功只代表消息入队，需要查看投递回执区分提交、接受和完成。
resume 只允许同一个 HCC peer/provider 持有的保存会话；已有 TUI/桌面会话继续使用
原 transport。托管权限请求与问题等待当前 Web 控制窗口或本地 CLI 明确应答，
并检查当前 worker/session/turn 身份。响应文件示例、SDK 安装、回执和接入边界见
[Native 后台 worker](native.zh-CN.md)。

## DeepSeek Harness

```text
hcc dsh setup [--mode hooks|cordis|off]
hcc dsh status [--dsh-bin PATH]
hcc dsh web [--mode hooks|cordis|off] [--dsh-bin PATH] [--dsh-home PATH] -- [dsh arguments]
```

验证基线为 `@deepseek-ai/dsh@0.2.0-rc.2`、Node.js 24+。Setup 生成项目局部配置，首次默认 hooks；`--mode cordis` 提供原生 `hcc_*` 工具和提交后 ACK，`--mode off` 关闭 overlay 注入，以后不带模式会沿用保存的选择。Status 校验文件与可执行文件，不调用模型。Harness 参数放在 `--` 后。Harness Web 会话通过自身界面交互；HCC 托管会话使用上方 native 命令控制。路由、bundle 和真实模型验收见[接入指南](dsh.zh-CN.md)。

## Peers 和状态

```text
hcc peers
hcc status [--peer ID]
hcc state [--peer ID] [--resource PATH] [--scope SCOPE] [--intent read|review|work|write|stop|finish]
hcc scan [--register]
hcc prompt --peer ID [--kind codex|claude|shell|other] [--role ROLE]
hcc join --peer ID [--kind codex|claude|shell|other] [--role ROLE]
hcc env --peer ID
hcc heartbeat [--peer ID] [--renew-locks --ttl 900]
hcc run --peer ID --kind codex|claude|shell --role ROLE -- COMMAND [ARGS...]
```

这些命令用于查看项目状态、注册终端，以及用 `HCC_PEER`、`HCC_ROOT`、
`HCC_DB` 环境运行 CLI。`hcc state` 不会执行确认消息、认领任务、获取锁或
创建 handoff 这类协作动作；它会返回统一协作时间线，以及
`automation.next_action.argv` 这种机器可读的下一步协作命令，供 agent 显式执行
并留下审计记录。`automation.current_task` 会记录当前 peer 已经拥有的活动任务。
使用 `--intent read` 或 `--intent review` 表示只做快照检查，不应获取文件锁；
写入/工作意图下可用 `--scope` 协调同一个大资源中的某个区域。

## Web 可控终端

```text
hcc peer list
hcc peer start PEER [--kind K] [--role R] [--cwd DIR] [--restart-env] -- COMMAND [ARGS...]
hcc peer start PEER --kind codex --resume SESSION_ID [--restart-env]
hcc peer start PEER --kind codex --last
hcc peer start PEER --kind claude --resume SESSION_ID [--restart-env]
hcc peer start PEER --kind claude --continue
hcc peer attach PEER [--pane PANE] [--kind K] [--role R] [--cwd DIR]
hcc peer stop PEER
hcc inject PEER TEXT [--no-enter]
```

这些命令创建或接入 tmux-backed 终端，让 Web 控制台可以观察和操作它们。

## 消息

```text
hcc msg send [--from ID] [--to ID|all] --body TEXT [--task N] [--kind note|task|handoff]
hcc msg inbox [--peer ID] [--wait SEC] [--all] [--limit N]
hcc msg ack [--peer ID] --id N
hcc msg reply [--from ID] --id N --body TEXT [--to ID] [--kind reply]
hcc msg thread --id N [--limit N]
hcc ask PEER MESSAGE [--from ID] [--task N] [--inject]
hcc broadcast MESSAGE [--from ID] [--task N] [--inject]
```

消息是带收件人的邮箱记录。`ask` 和 `broadcast` 加 `--inject` 后，也会把内容
实时注入到终端。回复某条消息时使用 `msg reply`；默认会发回原 sender，并保留
在同一个 thread 中。使用 `msg thread` 可以查看某条消息所在的完整线程。

## 任务

```text
hcc task create --title TEXT [--body TEXT] [--from ID] [--to ID] [--priority N]
hcc task dispatch --to ID --title TEXT [--body TEXT] [--from ID] [--message TEXT] [--no-inject] [--force]
hcc task dispatch --to ID --id N [--from ID] [--message TEXT] [--no-inject] [--force]
hcc task list [--status S] [--peer ID] [--all]
hcc task claim [--peer ID] --id N[,N] [--id N] [--ids N,N] [--force]
hcc task takeover [--peer ID] --id N --reason TEXT [--policy any|blocked|stale|blocked-or-stale] [--stale-after SECONDS]
hcc task next [--peer ID] [--force] [--count N]
hcc task create --title TEXT --parent N [--team-role ROLE]
hcc task update [--peer ID] --id N --status running|review|blocked|done|abandoned [--summary TEXT] [--body TEXT] [--to ID]
hcc task running|review|blocked|abandoned [--peer ID] --id N [--summary TEXT] [--body TEXT] [--to ID]
hcc task done [--peer ID] --id N --summary TEXT
```

任务是项目共享事实。任务会一直可见，直到被标记为 `done` 或 `abandoned`。
`task next` 会优先返回当前 peer 已经认领、运行、审查或阻塞中的任务；只有明确
要再接 pending 任务时才使用 `--force`，并可结合 `--count N` 做显式批量认领。
`task claim` 也支持重复 `--id`、逗号分隔的 `--id` 或 `--ids` 列表。`task
dispatch` 是显式的一步分发：创建或指定已有任务并分配给目标 peer、发送持久任务
消息，并且只在目标 peer 有正在运行的托管 Claude/Codex 终端时注入启动提示。只想
发消息时使用 `--no-inject`；目标已经拥有其他活动任务但仍要注入时，才使用
`--force`。明确要从其他 owner 手里接管未完成任务时，使用 `task takeover`；它要求
填写 reason，会记录原 owner 并通知对方。需要更保守时，可加 `--policy blocked`、
`stale` 或 `blocked-or-stale`，要求任务符合可审计的阻塞/陈旧条件后才允许接管。
默认 policy 仍是 `any`，以保持兼容。
`task running`、`task review`、`task blocked` 和 `task abandoned` 是
`task update --status STATUS` 的便捷写法。

## 团队

```text
hcc team plan --from-task N [--item ROLE:TITLE] [--item PEER:ROLE:TITLE] [--workers A,B|codex:2,claude:1]
hcc team start --from-task N [--item ROLE:TITLE] [--item PEER:ROLE:TITLE] [--workers A,B|codex:2,claude:1] [--force]
hcc team status --task N
```

团队是显式的父任务拆分。`team plan` 只读，只展示会创建哪些子任务。
`team start` 会在父任务下创建子任务，并可把子任务分配给 worker peer。
它不会静默启动模型进程，也不会绕过“先继续当前任务”的规则。`--workers`
支持显式 peer ID，也支持 `codex:2,claude:1` 这种 kind 数量形式。

## 锁、交接和事件

```text
hcc lock acquire [--peer ID] --resource PATH [--scope SCOPE] [--task N] [--ttl SEC] [--reason TEXT]
hcc lock renew [--peer ID] --resource PATH [--scope SCOPE] [--ttl SEC]
hcc lock release [--peer ID] --resource PATH [--scope SCOPE] [--force]
hcc lock list [--all]
hcc handoff create [--from ID] --summary TEXT [--task N] [--to ID] [--changed-files JSON_OR_CSV] [--tests TEXT] [--risks TEXT]
hcc handoff list [--task N] [--limit N]
hcc event tail [--limit N]
hcc gc [--older-than DAYS] [--yes]
```

锁是带 TTL 的协作式 advisory lock。不传 `--scope` 表示锁住整个资源。同一个
资源的不同 scope 可以并行持有，例如 `--resource bin/hcc.mjs --scope db-schema`
和 `--scope web-ui`；但整资源锁会和所有 scope 冲突。交接记录用于保存结果、
测试、变更文件和剩余风险，方便工作在多个 peer 之间继续。
