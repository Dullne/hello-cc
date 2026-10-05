# 桌面 Agent 通信

消息入库、进入模型上下文和完成回复是不同状态。`hcc native` 启动的自有 worker 与桌面已有会话也是不同连接。

以下入口从 `1.1.0-rc.5` 预览版本加入，要求 Node.js 24+。使用现有 `preview` 渠道安装；从源码运行时，可将下文的 `hcc` 替换为 `node ./bin/hcc.mjs`。Codex 会话内协作需要 `1.1.0-rc.7`；较早版本不包含这些协作命令。

| 对象 | 当前实现 | 验证边界 |
| --- | --- | --- |
| DeepSeek Harness App / Web | Cordis 插件在原 live Agent 中收件并唤醒 | 2026-10-06 原安装 Desktop、官方 DSH 0.2.0-rc.2、`deepseek-official/deepseek-flash` 实测空闲 bus 唤醒：0 次 prompt API、1 条回复、1 次 ACK |
| Claude Desktop Code | 绑定一个已有会话的可选 Mod，以及 HCC 收件／自动回复 | 需要内嵌引擎 2.1.287+；协议测试和官方 2.1.289 严格静态校验已通过，桌面实测待完成 |
| Codex App | 原会话终端协作和可选 MCP 插件，另保留只读 socket 检查 | 每次调用核对线程票据；支持活动会话内等待，不支持完全空闲自动唤醒。插件加载与 Hook 信任另做设备验证 |

## DeepSeek Harness

沿用 [Cordis 安装方式](dsh.zh-CN.md)。插件默认每 1000ms 检查真实存活 Agent，通过官方 `followup()` 唤醒有外来未读消息的空闲会话。活动会话仍在步骤及停止边界处理。

在 Harness 插件配置中设置 `inboxPollMs`：允许 `100..60000`，默认 `1000`；`0` 关闭自动空闲唤醒，保留活动步骤的协作工具与上下文。不要手改 HCC 带完整性校验的托管文件。

- 自身消息不触发空闲唤醒，也不会挡住排在后面的外来消息。
- 同一批消息只排队一次，准确的 `user/message` 提交后才 ACK。
- 准入拒绝、取消或准备失败后保持未读，不自动重试同一批外来输入；新外来消息或人工后续步骤可继续处理。
- 卸载只移除本插件未被领取的输入，不删除用户输入；热重载重新发现 live Agent。
- 热重载监听空档内的提交结果若不明，保持未读且不自动重放。
- 原有准入、工具审批、项目与 peer 身份约束继续生效。

隔离测试命令：

```sh
node scripts/dsh-inbox-acceptance.mjs --dsh-install /absolute/path/to/official-install
```

测试使用私有临时目录和 localhost 模型响应。ACP 只创建／清理隔离 Agent，**不调用 `session/prompt`**，不读取账号凭据或修改已安装 App。

## Claude Desktop Code

普通 Chat 和 CLI Channels 是其他入口。先检查目标 **Desktop 内嵌引擎**，单独升级 CLI 不代表桌面也已更新：

```sh
hcc app claude capability --version 2.1.287
hcc --root /absolute/project app claude serve --session-id EXISTING_SESSION_ID
```

第一条只检查版本前提；第二条为明确选定的已有 session ID 启动前台桥接，并输出 `marketplaceDirectory`、`pluginName`、`marketplace` 和 peer ID。随后由用户在原 Desktop Code 会话显式加载：

```text
/plugin marketplace add <marketplaceDirectory>
/plugin install <pluginName>@<marketplace>
/reload-plugins
```

Desktop 也提供 **＋ → Plugins → Add plugin**。生成器使用每次唯一的本地 marketplace 名称，防止复用旧桥接缓存。HCC 不自动安装、升级或改账号／全局配置。生成的 `hcc-session-link` 插件及其 marketplace 已通过官方 Claude Code 2.1.289 的 `claude plugin validate <directory> --strict` 校验。该静态校验不代替目标 Desktop 的版本检查和实机验收。

原会话不能同时由其他 HCC hooks/native/Mod 适配器持有。连接成功后，从其他 peer 发送：

```sh
hcc --root /absolute/project msg send --from coordinator --to PRINTED_PEER_ID --body '请检查当前任务的测试结果'
```

Mod 使用官方 `$.prompt.submit()` 并保留 Mod 来源。只有精确匹配输入的主回合完成才能确认消息，其他人工回合和子代理结果不能误确认。回复与 ACK 在一个数据库事务内提交，收到 `reply` 不再自动回复，避免循环。

排队、领取、开始均不等于完成。取消、断线或重启后的不确定投递保留未读与持久记录，不盲目重发。关闭桥接后，普通 Hooks 也不会重放这些旧输入；普通 inbox 查询仍可查看它们。先检查 App 的实际结果，再明确决定是否另发消息。

保持前台命令运行。Ctrl-C 清理这次生成的插件并关闭桥接，不结束 App 会话。插件目录含此次桥接的临时凭据（目录 0700、文件 0600），不能分享、提交或发布到公共市场。它不是 Claude 账号凭据；同一 OS 用户能读取该目录的代码属于本地信任范围，不提供 provider 签名身份。

依据：[Mods 概览](https://code.claude.com/docs/en/plugins/mods/overview)、[API](https://code.claude.com/docs/en/plugins/mods/api)、[插件安装](https://code.claude.com/docs/en/plugins/install)。

## Codex App

先为选定项目启用协作并生成本地插件市场：

```sh
hcc --root /absolute/project --json app codex setup --plugin-dir /absolute/new-marketplace
```

返回的市场名与插件名每次唯一。在 App 中添加这个本地市场并安装插件，再批准其 `UserPromptSubmit` Hook。配置不含会话票据，使用执行 setup 的准确 Node/HCC 路径；安装位置移动或升级后重新生成。setup 成功不代表 App 已加载插件或信任 Hook。

当前原 App 会话可立即通过自己的终端工具协作：

```sh
hcc --root /absolute/project --json app codex call --tool hcc_inbox
hcc --root /absolute/project --json app codex call --tool hcc_message_send \
  --arguments '{"to":"OTHER_PEER","body":"请检查当前改动。"}'
hcc --root /absolute/project --json app codex call --tool hcc_inbox_wait \
  --arguments '{"timeout_ms":45000}'
hcc --root /absolute/project --json app codex call --tool hcc_message_reply \
  --arguments '{"message_id":123,"receipt":"从收件结果取得的完整receipt","body":"检查完成，本地验证通过。"}'
```

这些命令使用本次终端调用的 `CODEX_THREAD_ID`，要求 `Codex Desktop` 来源标记；不启动 CLI 模型，不恢复线程，不控制其他 App 会话。新登记且未领任务的 peer 为 `idle`，后续查询保留已有任务状态，不会仅凭票据仍有效就把模型标为正在运行。

使用 MCP 时，在同一个 App 会话执行 `app codex session` 取得一小时有效的私有 `session_token`。13 个工具每次都要求票据，并另行核对宿主提供的 `_meta.threadId`。常驻 MCP 进程的启动环境不作为每次调用的身份。`_meta.sessionId` 与 Hook 的 `session_id` 被父会话及子代理共享，不能据此选收件箱，因此 Hook 只注入本会话取票／取件指引。票据不要写进聊天回复、消息或验收材料。`app codex disable` 撤销该项目全部票据；重新启用不恢复旧票据，也不接管其他 transport 的 owner。

`hcc_inbox`／`hcc_inbox_wait` 均不自动 ACK。确认已读时，用准确消息 ID 和 receipt 调用 `hcc_message_ack`；`hcc_message_reply` 在一个事务中记录关联回复并 ACK，相同重试返回原回复。它们都不代表任务完成。对 `kind=reply` 的消息只消费上下文，勿自动再次回复。peer 消息不构成用户授权。其余工具沿用 HCC 的任务、状态、交接、锁及本地证据规则。同连接等待允许其他会话并发发送，取消时结束等待。

等待最多 45 秒，必须由原 App 会话主动调用，不能唤醒已经完全空闲的聊天。官方 `Stop` Hook 可以延续正在结束的 turn，但不是外部空闲唤醒入口；本适配器不使用该事件，避免把共享 session ID 误配给子线程。

另外仍保留端点诊断：

```sh
hcc --root /absolute/project --json app codex probe \
  --socket /absolute/path/to/known-control.sock --thread EXISTING_THREAD_ID
```

只连接给定 Unix socket，初始化后调用 `thread/read(includeTurns:false)` 和有界的 `thread/loaded/list`。不扫描 socket、不启动 daemon、不读取账号或完整聊天历史、不调用 resume/start/interrupt。结束时仅断开自己的连接，原始 preview/name/error 不写进报告。

`loaded: null` 表示尚未确认。即使 loaded 为 true，`writable` 和 `desktopEndpointVerified` 也保持 false，因为该结果不能证明桌面正在使用同一执行器。

公开 `thread/resume` 既可加入 live thread，也可冷恢复会话，没有“只能附着已加载会话”的原子条件。这不意味着直接 `turn/start` 必须恢复：本次核对的官方 handler 只取得已加载线程，无 resume 分支，可能启动新 turn 或追加到活动 turn。外部直接发送仍缺少原 App 所有且受支持的端点，以及连接、订阅和授权约定；应用内聊天工具不自动构成 HCC 外部公开接口。

2026-10-06 的依据明确区分 Homebrew CLI 0.144.6 与当前 App 26.930.21537（12776）内嵌 CLI 0.159.0-alpha.12.1；后者已离线导出稳定及实验 schema。官方源码另固定为 `823ea830c0fd418b09ff02d36cad9a1fff66465b`，不声称源码与内嵌二进制逐字对应。参见官方 [MCP 每次调用的 metadata 实现](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/codex-rs/core/src/mcp_tool_call.rs#L1395-L1428) 和 [turn handler](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/codex-rs/app-server/src/request_processors/turn_processor.rs#L374-L388)。OpenAI Docs 官方页面已尝试在线重查：从 `developers.openai.com` 重定向到 `learn.chatgpt.com` 后返回 HTTP 403，正文未能验证。`app-server proxy` 传输 WebSocket 握手和帧，不是 native adapter 的 stdio JSONL。
