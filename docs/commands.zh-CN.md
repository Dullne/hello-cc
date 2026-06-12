# hello-cc 命令参考

使用 `hcc --help` 查看当前顶层命令列表。大多数子命令也支持 `--help`，
例如 `hcc update --help`、`hcc peer --help` 和 `hcc task --help`。

## 安装维护

```text
hcc update [--tag TAG] [--registry URL] [--dry-run]
hcc uninstall [--purge --yes]
```

`hcc update` 更新全局 npm 安装。`hcc uninstall` 移除本机 hooks 和 shims；
只有在确定也要删除当前项目的 `.hello-cc` 数据和指导块时，才加
`--purge --yes`。

## 启动和停止

```text
hcc web [--host HOST] [--port N] [--token TEXT] [--local] [--no-discover] [--no-guidance]
hcc down
hcc up [--no-discover] [--no-guidance]
```

`hcc web` 是默认入口。它会初始化协作状态，安装 hooks 和 shims，启动或复用
Web 控制台，然后把终端还给你。只想使用本地协作、不需要 Web 或 shims 时，
再使用 `hcc up`。

## Peers 和状态

```text
hcc peers
hcc status [--peer ID]
hcc state [--peer ID] [--resource PATH] [--intent work|stop|finish]
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
hcc task list [--status S] [--peer ID] [--all]
hcc task claim [--peer ID] --id N
hcc task next [--peer ID] [--force]
hcc task create --title TEXT --parent N [--team-role ROLE]
hcc task update [--peer ID] --id N --status running|review|blocked|done|abandoned [--summary TEXT] [--body TEXT] [--to ID]
hcc task done [--peer ID] --id N --summary TEXT
```

任务是项目共享事实。任务会一直可见，直到被标记为 `done` 或 `abandoned`。
`task next` 会优先返回当前 peer 已经认领、运行、审查或阻塞中的任务；只有明确
要再接一个 pending 任务时才使用 `--force`。

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
hcc lock acquire [--peer ID] --resource PATH [--task N] [--ttl SEC] [--reason TEXT]
hcc lock renew [--peer ID] --resource PATH [--ttl SEC]
hcc lock release [--peer ID] --resource PATH [--force]
hcc lock list [--all]
hcc handoff create [--from ID] --summary TEXT [--task N] [--to ID] [--changed-files JSON_OR_CSV] [--tests TEXT] [--risks TEXT]
hcc handoff list [--task N] [--limit N]
hcc event tail [--limit N]
hcc gc [--older-than DAYS] [--yes]
```

锁是带 TTL 的协作式 advisory lock。交接记录用于保存结果、测试、变更文件和
剩余风险，方便工作在多个 peer 之间继续。
