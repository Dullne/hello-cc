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
hcc scan [--register]
hcc prompt --peer ID [--kind codex|claude|shell|other] [--role ROLE]
hcc join --peer ID [--kind codex|claude|shell|other] [--role ROLE]
hcc env --peer ID
hcc heartbeat [--peer ID] [--renew-locks --ttl 900]
hcc run --peer ID --kind codex|claude|shell --role ROLE -- COMMAND [ARGS...]
```

这些命令用于查看项目状态、注册终端，以及用 `HCC_PEER`、`HCC_ROOT`、
`HCC_DB` 环境运行 CLI。

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
hcc ask PEER MESSAGE [--from ID] [--task N] [--inject]
hcc broadcast MESSAGE [--from ID] [--task N] [--inject]
```

消息是带收件人的邮箱记录。`ask` 和 `broadcast` 加 `--inject` 后，也会把内容
实时注入到终端。

## 任务

```text
hcc task create --title TEXT [--body TEXT] [--from ID] [--to ID] [--priority N]
hcc task list [--status S] [--peer ID] [--all]
hcc task claim [--peer ID] --id N
hcc task next [--peer ID]
hcc task update [--peer ID] --id N --status running|review|blocked|done|abandoned [--summary TEXT] [--body TEXT] [--to ID]
hcc task done [--peer ID] --id N --summary TEXT
```

任务是项目共享事实。任务会一直可见，直到被标记为 `done` 或 `abandoned`。

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
