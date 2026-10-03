# Web 继续本地任务：能力评估与实施方案

评估日期：2026-10-02。项目基于当前工作区；Codex 官方源码基于 `14a477ea89712071944244022e8a10142845456e`。下文保留完整目标；已实现范围见本节，不能把全部目标视为已交付。

## 本轮实现范围

- P0 Stop/stdout 投递修复已实现。
- P1 已实现按项目恢复选中、浏览器草稿、输入字节回执、连接状态与手动重连；服务端控制租约及 epoch 防旧请求，首次连接可取得控制，后续窗口观察；断线保留控制 15 秒，显式接管会使旧 epoch 失效。input、resize、管理注入、managed peer mutation、停止和替换已有会话验证控制权。lease 只协调 Web，不能阻止本地 tmux 键盘。
- P1 暂停接管写入现有 events 表；自动扫描、启动恢复和 orphan 收养尊重暂停，历史清理保护最新暂停/恢复事件。显式连接现有 pane 才解除暂停。本地任务和锁不因关页面或暂停接管自动移交。
- P2 已实现显式选择的 Codex stdio App Server、握手、thread start/resume/read/list/fork、turn start/steer/interrupt、结构化条目、计划、差异和命令/文件审批。Web 提供项目级历史分页与上下文预览；fork 生成独立 thread/peer，关闭临时历史执行器后才恢复新 thread。新会话采用 workspace-write 和人工审批，不改用户登录与信任配置。
- P2 恢复历史要求显式确认旧执行器已停止，并验证旧 owner 已死亡；存在已绑定 peer 时保留原 hcc peer 和 task owner。提交先保存 submission ID，重复 ID 不再执行，历史清理保护该回执。超时/断开不重放；无法明确关联的提交需停止旧执行器后从历史恢复。
- 关闭页面只断开 Web；停止 runtime 会关闭它拥有的 App Server，tmux 保留。App Server 重启不会自动继续未确认提交。当前 adapter 根据固定官方源码实现，不宣称已接入任意版本 daemon、嵌入式 TUI endpoint、完整协议类型生成或任意服务端审批请求。
- 独立 native runtime 的 Codex/Claude/dsh worker 可由 Web 发现并在原执行器中发送、中断、关闭，保留 provider session/peer/task owner；关闭 Web runtime 只断开视图。服务 generation、worker 实例 owner 与 provider session 在服务端原子复核，换实例撤销旧控制；Web submission ID 持久去重。native provider 的人工审批仍拒绝或报告不支持，不宣称有专用 App Server 的人工审批能力。
- P3 已实现专用 App Server 的项目/peer/executor 约束 MCP：state、task/inbox、消息、handoff、owned locks 和本地结果工具，复用现有业务规则与事务内身份检查；临时 capability 随执行器释放，不修改全局配置。Web 结果审阅关联 command/diff、MCP 本地证据与人工验收，分别记录 local/publication/business；不自动完成 task。结果和最小提交回执受到 history GC 保护。
- 仍未完成真实模型的本地/Web 连续任务、发布部署与业务验收。普通未托管终端的活跃进程迁移没有实现。任意版本 daemon/TUI 的共享 endpoint、完整 permissions/userInput/provider 审批以及官方协议类型生成不属于本轮实现。
- 本机 Codex 0.144.6 已在隔离 CODEX_HOME 中验证 initialize、thread start/list、10 个 MCP 工具发现与经 App Server 的 `hcc_state` 业务读取。真实 shim 在 exec 前后命令指纹不同，已修成握手完成后绑定 MCP 身份；未放宽身份校验。该验收没有模型推理。
- `doctor --codex` 已提供独立的版本/help、hooks 配置与 hook 调用诊断；没有成功回执的状态保持 unknown。探测禁用 shim 自维护和自动接管，并隔离、清理临时 HOME/CODEX_HOME。真实 Codex 0.144.6 验证了项目、用户目录和 hooks 文件保持原哈希；没有运行模型。

使用与边界见 [Web 接手使用说明](../web-handoff.zh-CN.md)。
最终本地验证记录见 [本轮验收记录](../verification/2026-10-02-web-local-task-handoff.md)。

## 目标

用户在本地开始一个任务，打开 Web 后立即看到同一个任务、会话和运行状态，能查看上下文、继续输入、处理审批，并在关闭 Web 后回到本地继续。切换操作入口不会自动转移任务 owner、重新开始任务、重放不确定的输入或启动第二个执行者。

## 最初基线与改进目标（当前实现已在上文更新）

| 场景 | 当前行为 | 接入或改进重点 |
| --- | --- | --- |
| shim / `hcc peer start` 启动的 Codex | tmux 托管，本地与 Web 连接同一 pane | 优先改善发现、任务标识、选中恢复和控制权体验，无需先换 SDK |
| 已存在的 tmux pane | 可用 `hcc peer attach` 纳入管理 | 提供“连接现有终端”的引导，显示目标项目与会话身份 |
| 未托管的普通终端 | hooks / 进程发现可提供协作状态，Web 显示 coordination-only | 不能把现有进程的终端任意转换为可控 PTY；历史恢复需要显式交接 |
| Web 断线 | 重新获取 action token，并接收终端 snapshot | 增加可见的连接恢复、草稿保留、手动重试和输入提交状态 |
| 多个 Web 窗口 | 最多四个连接，每个连接都能输入和 resize | 需要服务端控制租约，其他连接为观察者 |
| 任务与会话 | 有 task owner、peer、provider session binding 和 timeline | 增加明确的当前任务标题、provider thread 与当前 turn 的关联 |
| Codex 审批与过程 | 通过 CLI 终端显示和处理 | 结构化聊天、工具、审批、steer / interrupt 需要 App Server adapter |

仓库证据：

- `lib/web/auto-attach.mjs:83` 扫描并接入已发现的 tmux peer，默认每五秒扫描。
- `lib/web/runtime-main.mjs:485` 限制连接数，`:493` 为各连接签发 action token，`:510` 接受各连接的输入；token 是访问凭证，不是独占控制租约。
- `lib/web/ui-template.mjs:1440` 连接现有 managed session，`:1491` 建立终端 WebSocket，`:1522` 处理断线，`:1548` 显示 coordination-only peer。
- `lib/web/session-serialize.mjs:81` 返回 peer、provider session、root、cwd、pane 等身份。
- `lib/web/external-sessions.mjs:36` 接入 `hcc run` 发布的 buffer bridge；它与任意普通终端不同。
- `docs/guide.zh-CN.md:180` 说明共享 tmux、runtime 重启恢复及普通 raw 终端的限制。

## P0：可靠的 hooks 投递

Stop hook 有未读消息时应使用官方允许的 `{ "decision": "block", "reason": "..." }`，让 Codex 将 reason 作为继续执行的输入。SessionStart / UserPromptSubmit / PostToolUse 使用各事件支持的 `hookSpecificOutput.additionalContext`。

只有 stdout 写入成功完成后才标记本批消息已读；同步异常、异步写错误都保留未读。`stop_hook_active` 表示已在处理 Stop 续轮，本次应结束而不是递归阻止停止，新消息保留到下一个可投递事件。等待输出完成后自然结束，避免强制退出截断大段输出。

这里的成功是 hook 输出已交给管道，不是模型已理解或完成消息。后续应把队列写入、执行器接收、模型开始执行、任务完成分开记录，不能用一个“已读”状态代表全部阶段。没有执行器回执时不显示“模型已接收”。

只读诊断已补充 `doctor --codex`：检测实际 Codex 版本与 CLI help 声明的 App Server 启动参数，分别展示 hooks 配置和项目 hook 调用记录。`verifyCodexHooks()` 仍只说明配置条目存在，已有 hook 事件在 stdout 写入前记录，不能作为成功投递证据。hooks trust、stdout 投递和模型接受保持 unknown；完整 RPC 能力表与真实 hook receipt 验证仍需后续接入，不能自动信任或更改用户的 hooks 信任配置。

## P1：先改进现有 tmux 接手流程

1. **入口以任务为中心。** 会话卡片显示当前任务标题、项目、最近活动、连接能力和运行状态。区分“打开现有终端”“仅查看协作状态”“恢复历史会话”。查看现有任务不调用 task takeover。
2. **刷新后回到原位置。** 按项目保存选中的会话和未提交草稿；重连显示“连接恢复中 / 已同步 / 可输入”。活动会话消失时明确说明退出或无法访问，不自动新建会话。草稿保留在当前浏览器，提供清除选项，并遵守现有偏好模块处理 storage 不可用的方式。
3. **显式取得 Web 控制权。** 首个写入者取得租约，其他窗口仍可观察。服务端在 input、resize、终端命令注入及会话变更等写入口验证租约；断线后短期保留，再允许主动接手。观察者窗口尺寸不改变实际 TUI 尺寸。
4. **保留本地使用边界。** Web 租约只能约束经过 hello-cc 的写入，不能阻断绕过它的本地 tmux client 键盘。显示本地 client 是否正在连接，提供交接提示；不能宣称所有入口都已被独占锁定。
5. **输入反馈符合证据。** raw 终端可以确认服务端接受字节，不能据此判定 Codex 已提交 prompt。连接结果不确定时保留文本并提示检查终端，不自动重放 Enter 或整段命令。
6. **缩短回到上下文的路径。** 终端旁固定展示当前任务、最近 handoff、变更文件和验证记录；关闭 Web 只释放观察/控制连接，明确区分停止接管、停止执行器和终止任务。现有 Stop 对 tmux 默认 detach，但对 PTY / external bridge 会结束进程；活 tmux 还可能被自动重新收养。若提供“暂停 Web 接管”，必须保存显式状态并让自动发现尊重它，避免会话刚隐藏又出现。

优先使用现有 session serialization、WebSocket 和任务 API 扩展。租约与执行回执属于 runtime / 服务端状态，不能仅靠浏览器禁用按钮实现。

## P2：Codex App Server adapter

现有后端是 Node。TypeScript SDK 包装 `codex exec`，适合较简单的后台任务，但没有人工审批的双向请求通道；Python SDK 使用 App Server，给当前项目增加 Python 服务的成本应有明确收益。完整 Web 任务界面优先直接对接 App Server，并由同版本的 `generate-ts` 输出协议类型。

### 最小接入能力

| 能力 | 官方接口或事件 | Web 体验 |
| --- | --- | --- |
| 握手与能力识别 | `initialize` / `initialized`，固定运行时版本和生成的协议 | 明确哪些操作实际可用，不依赖终端文字猜测 |
| 定位与恢复会话 | `thread/list`、`thread/read`、`thread/start`、`thread/resume`、`thread/fork` | 看历史，恢复同一会话，分叉时显示新身份 |
| 继续和干预 | `turn/start`、`turn/steer`、`turn/interrupt` | 空闲时继续、运行时追加指令、停止当前轮 |
| 结构化状态 | `thread/status/changed`、`turn/started`、`turn/completed`、`item/started`、`item/completed`、`item/agentMessage/delta` | 对话、工具过程、进度和结果卡片 |
| 人工审批 | `item/commandExecution/requestApproval`、`item/fileChange/requestApproval` | 展示命令或文件修改后，由用户批准或拒绝 |
| 差异与计划 | `turn/diff/updated`、`turn/plan/updated` | 查看当前变更和计划，关联验证记录 |
| 持久化与重连 | 同一执行器的线程读取、状态重读、事件去重与提交记录 | 刷新 / runtime 重启后恢复已确认状态 |

审批请求存在于具体 server / thread / turn / request 上。Web 请求必须由后端验证这些关联及控制租约，禁止把另一轮审批结果用到当前请求。人工作出的审批决定直接对应 Codex 请求；不以“接手”动作自动批准工具。

### 运行和会话边界

- 第一期使用受 hello-cc 管理的本地 stdio 子进程，实现明确的执行器生命周期；只给需要的项目和执行器建立连接。
- 接入现有共享 daemon 前，探测运行实例的版本、endpoint 和 thread 所属实例；不能用随机新起的 App Server 冒充正在执行原任务的实例。
- 已托管的 TUI 保持 tmux 路径。要在 App Server 界面里继续活跃的本地任务，双方必须连接同一可访问的执行器实例，并协调同一 thread 的写入；官方 TUI 的进程内 embedded server 不自动对 hello-cc 暴露 endpoint。
- 对原始终端或不可访问的 embedded server，先让原轮结束 / 中断并明确交接，再按真实 thread ID 恢复。恢复历史是新执行器继续已保存上下文；不承诺迁移正在执行的命令、尚未持久化事件或未提交草稿。
- 一个 thread 同时只由一个执行器负责新 turn；新执行器绑定与旧实例退出 / 释放之间需要可检查的状态转换。禁止同时启动第二个 `codex resume` 与原执行器争用同一任务。
- daemon 会继承启动时的环境，不能把新终端的环境指纹误当成已运行 daemon 的实际环境。显示执行器的实际 model / provider / workspace，环境切换需要显式安排。

### 任务身份与回执

保持 `project root`、hcc `task ID`、`peer ID`、Codex `thread ID`、当前 `turn ID`、`executor ID` 的关系。hcc task 状态仍由任务状态机管理，模型 turn 完成不自动等于业务任务验收完成。

新增用户消息先持久化本地 submission ID 与状态，再提交到执行器。只有返回的 turn 或后续状态能与它确认关联时才显示已提交。断线时存在“服务端已执行但客户端没收到响应”的情况；协议没有可验证的幂等键时，不自动重发不确定的 `turn/start`，应重读 thread / turn 状态并让用户决定是否补发。

工具 / turn 事件用于渲染执行状态，持久化的任务、消息、锁和 handoff 仍属于 hcc。通过类型明确的 adapter 暴露能力，UI 按能力显示操作；Claude / shell / tmux 继续使用各自已有控制路径，不伪造它们拥有 Codex 专属事件。

## P3：协作工具与结果验收

将 hcc 的任务查询、消息、handoff、锁操作以受项目与 peer 身份约束的 MCP tools 提供给 Codex。hooks 继续承担兼容入口和提示职责。MCP tool 的成功回执也不等于模型已完成整个任务。

Web 增加 diff 审阅、测试结果与执行命令对应关系、下一步动作和完成验收；每次验收注明本地测试、发布 / 部署、真实运行的独立证据。移动端审批和草稿编辑优先使用普通表单控件，终端保留作细节查看入口。

## 验收路径

| 路径 | 通过标准 |
| --- | --- |
| 本地启动 managed Codex → Web 点击同一任务 | peer / task / pane 不变；不产生第二个执行器；已有输出可见 |
| Web 断线 → 重连 | 草稿保留；token 更新；恢复可信状态；不重复提交输入 |
| 两个 Web 窗口 | 一个控制者，另一个观察者；观察者写入和 resize 被服务端拒绝 |
| 本地 client 仍连接 | Web 明确显示并提示交接，不误称本地键盘已经被独占锁屏 |
| Web 关闭 → 本地继续 | Codex 进程、task owner 和项目锁保持正常；正常关闭 Web 不终止执行器 |
| 原始终端 → 请求接手 | 显示协作状态和明确迁移步骤，不承诺捕获原终端或自动启动重复会话 |
| App Server 等待审批 | Web 显示实际请求；审批绑定当前 request；关闭窗口不会自动同意 |
| App Server 正在运行 → steer / interrupt | 发给同一 thread / turn，并以事件确认操作结果 |
| 不确定的 turn 提交 → 恢复网络 | 重读状态，不自动重复 `turn/start`；向用户展示确定和不确定部分 |
| hooks stdout 失败 / Stop 续轮 | 消息保留未读，无无限续轮；正常投递后同一消息不重复出现 |

以上是实施验收标准，不是已完成的设备或业务验收。先用 fake provider 与独立项目进行自动化，再用明确授权的真实 Codex 会话完成本地 / Web 连续使用验收。

## MCP 表单补齐

标准 `mcpServer/elicitation/request` 的 `form` 模式现已接入字段填写、前后端共享校验和原请求应答，覆盖文本、数值、布尔值与单选/多选。两种 Web 接手路径以及 CLI `--response-file` 共用此能力。默认建议值不会自动成为可选字段答复，填写内容仅保留在页面内存，不写入 HCC 事件或回执。未支持的结构、URL/device 身份认证和扩展模式提供拒绝/取消。详细边界与本次独立验收见 `docs/verification/2026-10-02-mcp-form-web-validation.md`；既有真实模型回执不作为本次表单的模型验收证据。

## 官方源码依据

- [TypeScript SDK 包装 CLI / JSONL](https://github.com/openai/codex/blob/14a477ea89712071944244022e8a10142845456e/sdk/typescript/README.md#L5)。
- [Python App Server stdio 客户端](https://github.com/openai/codex/blob/14a477ea89712071944244022e8a10142845456e/sdk/python/src/openai_codex/client.py#L215)。
- [TUI / exec 共享内部 App Server 客户端](https://github.com/openai/codex/blob/14a477ea89712071944244022e8a10142845456e/codex-rs/app-server-client/README.md#L3)。
- [App Server transport 与生成 TypeScript 协议](https://github.com/openai/codex/blob/14a477ea89712071944244022e8a10142845456e/codex-rs/cli/src/main.rs#L568)。
- [thread 生命周期](https://github.com/openai/codex/blob/14a477ea89712071944244022e8a10142845456e/codex-rs/app-server-protocol/src/protocol/common.rs#L551)、[turn 控制](https://github.com/openai/codex/blob/14a477ea89712071944244022e8a10142845456e/codex-rs/app-server-protocol/src/protocol/common.rs#L1043)、[审批请求](https://github.com/openai/codex/blob/14a477ea89712071944244022e8a10142845456e/codex-rs/app-server-protocol/src/protocol/common.rs#L1783)、[状态通知](https://github.com/openai/codex/blob/14a477ea89712071944244022e8a10142845456e/codex-rs/app-server-protocol/src/protocol/common.rs#L1964)。
- [Stop 输出类型](https://github.com/openai/codex/blob/14a477ea89712071944244022e8a10142845456e/codex-rs/hooks/src/schema.rs#L451)、[Stop continuation 处理](https://github.com/openai/codex/blob/14a477ea89712071944244022e8a10142845456e/codex-rs/hooks/src/events/stop.rs#L312)。
- [daemon 环境、连接与 experimental 生命周期边界](https://github.com/openai/codex/blob/14a477ea89712071944244022e8a10142845456e/codex-rs/app-server-daemon/README.md#L3)。
