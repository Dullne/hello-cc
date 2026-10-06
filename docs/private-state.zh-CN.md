# 项目目录身份与私有状态

[English](private-state.md) | 中文

请使用包含下方命令的版本；旧的全局安装可能尚未支持。这份文档说明状态处理
规则，不代表已完成设备安装、模型调用或生产状态迁移。

## 目录选择与状态位置

HCC 将所选项目绑定到 canonical 目录与文件系统身份（`dev`、`ino`、
`birthtimeNs`），并在打开状态、启动会话和接收受控修改前复核。同一路径被替换
后属于另一个项目目录。遇到 `PROJECT_PATH_CHANGED` 应重新选择当前目录；已有
会话仍保留原目录绑定。

稳定且可信的项目可以把状态保存在 `<project>/.hello-cc`。需要私有状态的项目
使用 `~/.hello-cc/projects/<canonical-root的SHA256>/`。私有绑定建立后，即使
权限变化或目录丢失，它仍是权威状态；HCC 不会静默退回旧的项目局部数据库。

私有绑定 v2 保存完整目录身份，要求文件系统提供正值的目录创建时间；缺失或
零值会被拒绝。原目录 A 已有有效 v2 绑定，而同一路径后来被
B 占用时，Web 的明确目录选择可在
`~/.hello-cc/projects/<hash>.generations/<generation>/` 为 B 建立独立状态。
A 的状态目录与根 manifest 保留，原 authority marker 增加阻止旧版读取的标记。
B 使用独立状态和 managed tmux namespace。分代记录丢失、冲突或没有对应绑定时
要求恢复，不会自动复用。私有绑定版本与 mesh 数据库 schema 版本彼此独立。

## 迁移项目局部状态

遇到 `STATE_MIGRATION_REQUIRED` 时，先停止全部写入者，再把保留的项目局部
状态迁入私有目录。写入者包括 Web、Native runtime、PTY/tmux 会话、hooks、
Harness 进程和外部数据库客户端。备份项目局部状态，以及已有的私有目录、
authority marker 和 generation 记录。

```sh
hcc --root /absolute/path/to/project migrate-state --offline --yes
```

迁移会检查已记录的 runtime、PTY 和 mesh 进程证据，创建包含 WAL 的 SQLite
快照并校验，保留源目录。`--offline` 是操作者对全部写入者已停止的断言；已记录
进程不能证明没有未登记写入者。受管理的 DSH 文件会先验证、归档，再按私有路径
重建。受管理 DSH 文件被改、文件系统条目不安全或快照期间来源改变时会被拒绝。

## 升级历史私有 v1 绑定

`STATE_BINDING_UPGRADE_REQUIRED` 表示已有私有状态缺少 v2 的目录创建时间绑定。
仅有相同路径、device 和 inode 不能确认当前目录就是历史 A。升级前应独立核实
A 的身份，并冷停机全部写入者。若当前路径已是 B，应先在该路径恢复并核实 A；
选择 B 不会自动升级 A 的历史 v1 元数据。

先检查，保持绑定不变：

```sh
hcc --root /absolute/path/to/project --json migrate-state --inspect-private-binding
```

结果包含 `status`；需要升级或尚未完成时包含 SHA256 `receipt`。回执描述当前
观察到的元数据，不能证明当前目录就是历史 A。独立核实、备份并完成冷停机后，
把本次准确回执复制到：

```sh
hcc --root /absolute/path/to/project migrate-state \
  --upgrade-private-binding --offline --yes --assert-historical-root \
  --expect-receipt=COPY_THE_INSPECTION_SHA256
```

升级在发布前后检查已知写入者，先持久化阻止 v1 读取的标记，再写入 v2 根
manifest，最后清除 pending 标记。它只升级绑定元数据，不复制状态目录。发布
失败或第二次离线检查失败时，状态仍被封锁。重新检查后，在同一个已核实根目录
和匹配回执下重试；报告需要人工恢复时保留全部证据。不要伪造 marker 或清空
历史状态来绕过升级。旧版本可能拒绝 v2 状态，应先停止旧版本的执行再切换。

## 暂停新启动

`HCC_PINNED_LAUNCH_MODE` 只接受 `pinned`（未设置时也是默认行为）或 `hold`。
`hold` 以 `PINNED_LAUNCH_PAUSED` 拒绝新的受控会话启动，不终止已有进程，也
不撤销已经准备完成的启动。其他取值被拒绝。provider 环境清除 HCC 变量也不能
解除父进程的 hold。用于固定目录文件或指导块操作的 maintenance worker 仍可运行。

环境变量应设置在调用 HCC 的进程上；后来修改另一个 shell 的环境不会更新正在
运行的 Web 或 Native runtime。hold 不能代替迁移前停止全部写入者。

## Codex 终端历史边界

HCC 的 Codex 历史入口要求持久化的 thread 与原根目录身份回执。内置 new/fork
启动记录最终 thread 的原目录，resume/fork 同时校验目录身份与明确 thread ID。
Web 历史列表省略未核实或冲突的记录，并返回这类记录的数量。旧的 cwd 字符串、
导入的 peer 记录或手工拼接命令都不能建立可信绑定。
`CODEX_HISTORY_UNVERIFIED` 和冲突绑定需要人工审查；HCC 未提供自动关联历史的命令。

终端 `codex resume --last` / `codex fork --last` 无法确定准确 thread，因此被这些
受控入口拒绝；应选择明确且已核实的 thread ID。[Native worker](native.zh-CN.md)
采用独立的保存会话与所有权规则，仍支持 `native start --resume last`。
