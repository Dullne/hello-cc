# 桌面 Agent 通信接入计划

基线：`002a2df016dee3d1a504a1e85b42204c8b6a922c`（主分支，1.1.0-rc.4）。

目标是向 App 已有的真实会话投递 HCC 消息，空闲时启动处理，并把回复送回同一条消息总线。托管 CLI worker、工具可调用、桌面会话可唤醒必须分别验收。共享工作区和既有稳定版验收工作树保留；本轮在独立工作树实现。

## 当前进度

| 阶段 | 本地实现 | 尚需完成 |
| --- | --- | --- |
| DSH | 原 live Agent 空闲收件、准入后 ACK、官方运行时隔离验收 | 已安装 Desktop UI 与真实模型验收 |
| Claude Desktop Code | 可选 Mod、私有 HTTP 桥、消息总线／回复闭环、Hooks 共存与断线防重放 | 新版官方插件校验器，以及内嵌引擎 2.1.287+ 的实机验收 |
| Codex App | 显式 UDS 的只读会话探测 | 可证明归属桌面且具有原子附着保证的公开写入入口；消息投递未实现 |
| 交付 | 独立工作树、中英使用文档与验证记录 | 尚未合并、发布或安装本轮候选版本 |

这些完成项仅描述本轮实现和对应证据，不表示三种桌面 App 已全部互通。操作入口见 [桌面 Agent 通信](../app-bridge.zh-CN.md)。

本地验证：静态审计通过；1825 项单测通过、2 项平台／权限条件跳过；完整回归 13/13；官方 DSH 运行时隔离验收 5/5。详见 [验证记录与后续门槛](../verification/2026-10-05-app-agent-bridge.md)。

## 1. DeepSeek Harness

官方基线为 `@deepseek-ai/dsh-agent` / `dsh-agent-loop@0.2.0-rc.2`。

1. 在现有 Cordis 插件内按真实 Agent/session/project/peer 轮询收件箱，复用现有权限和业务服务。
2. 空闲且有完整未读消息时调用官方 `agent.followup()`。已有活动回合仍通过 pre-step / turn-stopping 处理。
3. 同一批消息只保留一个待处理唤醒；pre-step 不重复添加已排队的上下文。
4. 保留下游步骤准入决定。只有对应 `session/event user/message` 提交后 ACK。拒绝、取消、准备失败均不得提前确认或自动重复启动同一批输入。
5. 退出和插件卸载停止轮询，移除本插件尚未被领取的排队输入，不删除用户输入。热重载重建真实存活 Agent 的身份。
6. 增加可配置轮询周期，支持关闭自动唤醒。没有消息时不得调用模型。

验证：生命周期与竞态单测；固定官方 Harness 运行时的隔离验收，以本地确定性模型响应测试空闲收件、回复、ACK、拒绝准入、无空转和跨项目隔离。该验收不等于真实模型或已安装桌面 UI 验收。

## 2. Claude Code Desktop

采用官方支持 Desktop Code 的 Mods API。cross-session inbox 未取得完整 wire schema，不作为本轮实现的传输入口。

1. 核对当前 CLI 与 Desktop 内嵌引擎版本。Mods 要求 2.1.287+；当前设备查得 CLI 2.1.204、Desktop 1.24012.1 内嵌 pin 2.1.217，尚不满足条件。
2. 前台 `hcc app claude serve` 为一个明确 session／项目生成私有本地 marketplace，由用户在原 Desktop Code 会话加载。
3. Mod 通过 `$.prompt.submit()` 投递并保留来源，以精确输入、主回合 ID 和 `turn.complete` 关联完成，不接管 App 生命周期。
4. 同一事务写入回复及 ACK；先持久化发送意图，取消、断线或重启结果不明时保留未读且不盲重试。关闭后普通 Hooks 不重放这些旧输入。
5. 完成协议和 Mod API 模拟测试，再运行官方 `claude plugin validate --strict` 和新版 Desktop 隔离会话验收。普通 MCP、CLI Channels 与模拟测试均不代替桌面自动收件证据。

## 3. Codex App

核对应用内聊天工具与外部 app-server 控制端点的关系。`codex app-server` 新进程和桌面已有会话分别处理。

1. 优先官方公开控制入口，核对本机 CLI `app-server proxy` 支持的连接方式与生命周期。
2. 只有用户明确指定、且能证明与目标 App 相同的端点，才可作为桌面桥接目标。不得猜测私有端点或借用 App 注入的权限。
3. 绑定原 thread、项目和连接代次；忙碌投递、审批和回复完成事件需要独立验证。
4. 断开 HCC 只能关闭自己的连接，不能结束桌面进程或会话。
5. 未证明桌面与端点归属一致时，继续保留现有 HCC-owned app-server 模式，桌面适配标记为待验证。

本轮只实现 `hcc app codex probe`：初始化、`thread/read(includeTurns:false)` 和有界 `thread/loaded/list`。`thread/resume` 可冷恢复会话且缺少原子 only-loaded 条件，因此不将先查询再恢复实现为桌面纯附着；返回值始终保持 `writable:false`、`desktopEndpointVerified:false`。

## 4. 通用验收与交付

- 消息入库、提交给 provider、进入会话上下文、模型回复与任务完成分别记录，不互相代替。
- 不改账号、全局 MCP 配置或现有聊天；真实设备验证只针对明确隔离的测试会话。
- 单测和官方运行时测试通过后更新中文/英文使用说明及能力矩阵。
- 发布和安装回执绑定实际候选提交；本地源码通过不自动等同已发布或三种桌面全部接通。
