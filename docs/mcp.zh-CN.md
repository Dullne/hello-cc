# 受执行器约束的 MCP 协作工具

Web 专用 Codex App Server，以及由 HCC 托管的 Codex/Claude/dsh native worker，都会获得专用 stdio MCP 配置。它固定项目 root、数据库、peer、worker owner 和活动 runtime 进程身份。配置通过 provider 会话 API 传入，不写用户的全局配置、账号或信任设置。

| 工具 | 作用 |
| --- | --- |
| `hcc_state` | 查询当前项目/peer 的协作状态 |
| `hcc_task_list` / `hcc_task_next` | 查询任务，返回已有任务或领取一个待办 |
| `hcc_inbox` | 读取当前 peer inbox，不自动确认消息已处理 |
| `hcc_message_send` | 以当前执行器 peer 身份写入项目消息总线 |
| `hcc_handoff` | 记录已归属任务的工作、测试和风险 |
| `hcc_lock_acquire` / `hcc_lock_release` | 获取或释放当前 peer 的资源锁 |
| `hcc_result_list` / `hcc_result_record` | 读取结果记录，写入已归属任务的本地证据 |

模型不能通过工具参数更换项目、数据库、peer，不能强制夺取别人的锁。每次调用检查原执行器仍存活且数据库 binding 仍由它持有；写入还在业务事务内复核身份与任务归属。执行器关闭、peer 被替换或能力凭据被撤销后，旧 MCP 进程不能继续写入。

内部入口为 `hcc --root PROJECT --db DATABASE mcp serve --peer PEER`。它需要执行器创建的临时私有 capability 文件及 token，单独填写 `--peer` 不授予身份。文件权限在 Unix 为目录 0700、文件 0600，执行器退出后删除。手工启动不会注册或覆盖已有 peer。

MCP 复用现有任务、消息、锁与 handoff 命令的业务规则。工具返回成功只说明对应协作操作完成；不会自动把任务改为 done。`hcc_result_record` 只报告本地证据，模型填写的记录会注明来源，不代替 Web 中人工记录的发布部署或业务验收。

native worker 在启动前建立受限 capability，关闭 worker 或启动失败清理前撤销。Codex 通过 thread config、Claude 通过 SDK mcpServers、dsh 通过 ACP session mcpServers 接入。任意外部 CLI/TUI 不会自动获得此权限。发信等写操作仍可能需要 provider 人工审批，处理方式见 [Native 指南](native.zh-CN.md)。

三种模型使用 MCP 发送协作消息的真实回执见 跨 provider 通信验收 (源码目录: `docs/verification/2026-10-02-native-live-communication.json`)。模型发信、接收方回复、ACK 和无回复循环均有单独检查；这不代替发布安装或业务任务验收。
