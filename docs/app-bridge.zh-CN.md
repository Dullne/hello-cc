# 桌面 Agent 通信

消息入库、进入模型上下文和完成回复是不同状态。`hcc native` 启动的自有 worker 与桌面已有会话也是不同连接。

本轮新增入口位于源码候选，尚未发布或安装。在该源码目录中使用 Node.js 24+，可将下文的 `hcc` 替换为 `node ./bin/hcc.mjs`；全局已安装版本不一定包含这些命令。

| 对象 | 当前实现 | 验证边界 |
| --- | --- | --- |
| DeepSeek Harness App / Web | Cordis 插件在原 live Agent 中收件并唤醒 | 固定官方运行时＋本地确定性模型，尚不代表已安装桌面真实模型验收 |
| Claude Desktop Code | 绑定一个已有会话的可选 Mod，以及 HCC 收件／自动回复 | 需要内嵌引擎 2.1.287+；目前完成协议与 Mod API 模拟测试 |
| Codex App | 显式 app-server socket 的只读检查 | 不发 prompt、不恢复会话，尚未证明端点归属桌面 |

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

Desktop 也提供 **＋ → Plugins → Add plugin**。生成器使用每次唯一的本地 marketplace 名称，防止复用旧桥接缓存。HCC 不自动安装、升级或改账号／全局配置。生成的插件可用官方 `claude plugin validate <pluginDirectory> --strict` 检查；本轮未取得新版校验器的成功回执。

原会话不能同时由其他 HCC hooks/native/Mod 适配器持有。连接成功后，从其他 peer 发送：

```sh
hcc --root /absolute/project msg send --from coordinator --to PRINTED_PEER_ID --body '请检查当前任务的测试结果'
```

Mod 使用官方 `$.prompt.submit()` 并保留 Mod 来源。只有精确匹配输入的主回合完成才能确认消息，其他人工回合和子代理结果不能误确认。回复与 ACK 在一个数据库事务内提交，收到 `reply` 不再自动回复，避免循环。

排队、领取、开始均不等于完成。取消、断线或重启后的不确定投递保留未读与持久记录，不盲目重发。关闭桥接后，普通 Hooks 也不会重放这些旧输入；普通 inbox 查询仍可查看它们。先检查 App 的实际结果，再明确决定是否另发消息。

保持前台命令运行。Ctrl-C 清理这次生成的插件并关闭桥接，不结束 App 会话。插件目录含此次桥接的临时凭据（目录 0700、文件 0600），不能分享、提交或发布到公共市场。它不是 Claude 账号凭据；同一 OS 用户能读取该目录的代码属于本地信任范围，不提供 provider 签名身份。

依据：[Mods 概览](https://code.claude.com/docs/en/plugins/mods/overview)、[API](https://code.claude.com/docs/en/plugins/mods/api)、[插件安装](https://code.claude.com/docs/en/plugins/install)。

## Codex App

```sh
hcc --root /absolute/project --json app codex probe \
  --socket /absolute/path/to/known-control.sock --thread EXISTING_THREAD_ID
```

只连接给定 Unix socket，初始化后调用 `thread/read(includeTurns:false)` 和有界的 `thread/loaded/list`。不扫描 socket、不启动 daemon、不读取账号或完整聊天历史、不调用 resume/start/interrupt。结束时仅断开自己的连接，原始 preview/name/error 不写进报告。

`loaded: null` 表示尚未确认。即使 loaded 为 true，`writable` 和 `desktopEndpointVerified` 也保持 false，因为该结果不能证明桌面正在使用同一执行器。

公开 `thread/resume` 既可加入 live thread，也可冷恢复会话，没有“只能附着已加载会话”的原子条件。当前实现不把先检查再 resume 的竞争窗口当成纯附着。应用内聊天工具也不自动构成 HCC 外部程序的公开入口。

参考依据为本机官方 CLI 0.144.6 的帮助与 schema 快照，以及本机官方源码树 `d109393270432531ac0010542ae7973801e0d9d7` 的 app-server README／协议定义。未证明源码树与 CLI 构建版本完全对应，也未完成官方网页在线复核。`app-server proxy` 传输 WebSocket 握手和帧，不是 native adapter 的 stdio JSONL。
