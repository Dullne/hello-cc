# Native 后台 worker

Native 模式运行由 HCC 创建并持有的后台 worker。共享 peer、任务、消息、锁和交接
仍由 HCC 管理；每个 provider adapter 管理自己的执行连接，并报告结构化生命周期
事件。

| Provider | 连接方式 | 会话身份 | 忙碌时的新输入 |
| --- | --- | --- | --- |
| Codex | HCC 持有的 `codex app-server`，stdio JSON-RPC | Codex thread ID | adapter 支持带活动 turn 前置条件的 `turn/steer` |
| Claude | 可选 Claude Agent SDK，持久双向输入流 | SDK 初始化确认的 Claude session ID | 一次一个 submission，暂不支持 steer |
| DeepSeek Harness | HCC 持有的 `dsh --profile acp` 进程 | ACP session ID | 一次一个 submission，暂不支持 steer |

当前 HCC host 对每个 worker 逐条投递 inbox 消息，Codex 也一样。adapter 支持 steer
不代表 host 会把多条待处理消息塞进同一个 turn。ACP 的 resume 和 session close
取决于 provider 声明的扩展；不能把 ACP resume 等同于重放原始会话历史。

## 环境准备

需要 Node.js 24 或更新版本，并在运行 HCC 的同一环境中安装、登录对应 provider。
Native 模式保留身份认证配置，不改写账号、provider 设置或用户主目录。

Codex 需要支持 app-server 的 CLI。DeepSeek Harness 使用 ACP profile，实现基线为
`@deepseek-ai/dsh-acp@0.2.0-rc.2`；此模式不连接已有 dsh Web service。

Claude SDK 保持可选，只在打开 Claude worker 时动态加载。在本仓库 checkout 中，
手动安装文档指定版本：

```sh
npm install --no-save --package-lock=false @anthropic-ai/claude-agent-sdk@0.3.287
```

如果 HCC 通过 npm 全局安装，在同一个 npm prefix 中安装 SDK：

```sh
npm install -g @anthropic-ai/claude-agent-sdk@0.3.287
```

也可以只在 worker 的项目目录中安装 SDK：

```sh
cd /absolute/path/to/worker-project
npm install --no-save --package-lock=false @anthropic-ai/claude-agent-sdk@0.3.287
```

默认加载器先查 HCC 安装位置，再查 worker 项目的依赖；因此全局 HCC 也可使用项目内
安装的 SDK。HCC 不会自动安装包。找不到 SDK 时给出安装提示；SDK 已找到但导出或
内部依赖损坏时保留真实错误，避免误报“未安装”。默认路径的真实 Web 工具审批
已有独立回执 (源码目录: `docs/verification/2026-10-02-native-web-claude-default-sdk.json`)，不代表
发布包或员工设备已完成安装验收。

## CLI 使用

在需要共享状态的项目目录中运行，或使用已有全局 `--root`、`--db` 指定项目和数据库。

```sh
hcc native up
hcc native start --peer codex-reviewer --provider codex
hcc native start --peer claude-reviewer --provider claude
hcc native start --peer dsh-reviewer --provider dsh
hcc native send --peer codex-reviewer --from coordinator --body "审查当前修改，报告具体问题和证据。"
hcc native status
hcc native deliveries --peer codex-reviewer
hcc native events --peer codex-reviewer --after 0
hcc native requests --peer codex-reviewer
hcc native respond --peer codex-reviewer --request REQUEST_ID --decision accept
hcc msg inbox --peer coordinator
```

`start` 会按需启动本项目的 native runtime。`--cwd DIR` 可以指定 worker 工作目录，
它仍共享 host 所选项目的 HCC 消息总线。`--model MODEL` 选择 provider 支持的模型；
`--binary PATH` 覆盖 Codex 或 dsh 可执行文件。Claude 使用 SDK，传入 `--binary`
会直接报错。

| 命令 | 参数与作用 |
| --- | --- |
| `hcc native up` | 启动或复用本项目后台 runtime |
| `hcc native status` | 查看持久化 worker 状态和 runtime 身份 |
| `hcc native start` | 必须 `--peer NAME --provider codex\|claude\|dsh`；可选 `--cwd DIR --model MODEL --resume last`；`--binary PATH` 仅适用于 Codex 和 dsh |
| `hcc native send` | 必须 `--peer NAME --body TEXT`；可选 `--from NAME --task ID`；返回持久消息/submission 回执 |
| `hcc native deliveries` | 可选 `--peer NAME`，查看投递回执 |
| `hcc native events` | 必须 `--peer NAME`；可选 `--after ID`，查看有界事件历史 |
| `hcc native requests` | 必须 `--peer NAME`；查看与该执行器、会话、turn 绑定的待处理请求 |
| `hcc native respond` | 必须 `--peer NAME --request ID --decision accept\|decline\|cancel`；权限子集或问题答案通过 `--response-file JSON` 提交 |
| `hcc native interrupt` | 必须 `--peer NAME`；可选 `--turn ID`，请求中断活动 turn |
| `hcc native close` | 必须 `--peer NAME`，关闭该 worker 持有的连接或进程 |
| `hcc native down` | 请求关闭 worker 和停止 runtime，返回停止请求回执 |

`native down` 的回执只确认停止请求，不证明关闭已完成。需要检查 `native status`
确认结果。若 provider 关闭失败，HCC 保留 runtime owner，并在
`status.shutdown_error` 报告错误；处理所报问题后，再次执行 `native down`。

事件保留语义输出和完成证据，不把 token delta 持久化为投递回执。runtime 状态位于
`<project>/.hello-cc/native/`，协作记录仍写入所选 HCC 数据库。控制接口是独立于 Web
终端传输的本地认证 API；其 runtime pointer 和日志属于项目私有状态。

## 如何理解投递回执

`native send` 成功只代表消息已入队，不能据此声称 provider 已读、执行完成或产出
真实业务结果。

| 状态 | 含义 |
| --- | --- |
| `queued` | 已写入 HCC 消息总线，等待投递 |
| `dispatching` | HCC 开始把 submission 交给 adapter，provider admission 尚未确认 |
| `submitted` | adapter 已把 prompt 写入或排入输入流，尚无 provider admission 回执 |
| `accepted` | provider admission 回执或对应 provider 输出证明该 submission/turn 已开始处理，工作仍未完成 |
| `completed` | 对应的主 turn 权威结果报告成功，HCC ACK 该消息；非 reply 消息可以自动写回回复 |
| `failed` | 明确拒绝或不成功的主 turn 结果，不代表成功 ACK |
| `uncertain` | 超时、进程/连接丢失或 runtime 重启后结果不明，自动重试可能重复执行 |

SDK 消费输入迭代器只能证明传输提交，不代表 provider 已接受或模型 turn 已完成。
Claude 观察到对应 assistant 输出后，才从 `submitted` 升为 `accepted`。Claude 在初始化事件
中确认真实 session ID；刚打开 worker、尚未发送首条 prompt 时，session ID 可以为
null。中断请求本身不会完成投递，也不一定取消还在 SDK 队列中的输入；需要对应主
turn 结果才能归结。

inbox 中 `kind: 'reply'` 的消息仍作为 context 投递，主 turn 成功后才 ACK。其输出
保留在 `events` 中，但 HCC 不再自动生成 reply，避免回复回路。其他 kind 的消息在
主 turn 成功且有输出时，自动向发送方写回 reply。

出现 `uncertain` 时，先检查 `deliveries`、`events` 和 provider 状态，再决定是否发送
替代消息。HCC 不自动重投 uncertain 记录；runtime 重启会把在途状态记为 uncertain，
不会假定已经失败或完成。

## 会话所有权、hooks 和权限

使用同一个 peer、同一个 provider 恢复 HCC 保存的会话：

```sh
hcc native close --peer codex-reviewer
hcc native start --peer codex-reviewer --provider codex --resume last
```

显式 session ID 也必须与 HCC 保存的该 peer/provider 记录一致。resume 通过新持有
的连接恢复会话历史，不是附着已有的活动 TUI 或桌面实例。HCC 无法证明外部应用
没有独立打开同一个保存会话，因此不要同时在 owned runtime 外写入该会话。

worker 获得明确的 `HCC_ROOT`、`HCC_DB`、`HCC_PEER`、`HCC_NATIVE_OWNER`。provider hook
必须匹配该 peer 的 native transport owner。native hook 路径只刷新 owner 心跳和续
期其锁，不覆盖 provider binding 或进程身份、不再次注入 inbox、不 ACK 消息，也
不阻塞 Stop hook。owner 标记不匹配时直接拒绝，不回退到普通终端 hook 投递。

provider 保留各自的权限检查。runtime 托管的请求等待当前 Web 控制窗口或本地 CLI
明确应答；关闭 Web 后，worker 和待处理请求仍可由本地 CLI 继续处理。应答同时
检查 runtime generation、worker owner、provider、executor、session、turn 和 request
ID。观察窗口不能应答，控制权切换后旧窗口的 epoch 失效。

| Provider | 已接入的人工交互 |
| --- | --- |
| Codex | 命令/文件审批、所请求文件与网络权限的子集、明确的 turn/session 有效期、选项/自由输入/敏感问题，以及单次空表单 MCP 工具确认 |
| Claude | SDK 工具权限 callback，批准原始输入本次执行，不改写工具参数 |
| dsh ACP | 选择 provider 提供的 `allow_once`，不自动选择 `allow_always` |

rc.2 的 ACP 审批可能只携带工具 ID。适配器会关联同一 session/turn 的工具更新以展示操作输入；等待后仍缺输入或输入被截断时可以拒绝，允许会返回 `NATIVE_APPROVAL_CONTEXT_MISSING`。实际安装与拒绝证明见 dsh 验收 (源码目录: `docs/verification/2026-10-02-dsh-cordis-native.md`)。

Codex 交互会话在 thread start/resume 的私有配置中显式开启
`features.default_mode_request_user_input` 和 `features.request_permissions_tool`，
使执行模式下的模型能够调用提问和权限请求工具。Web 专用 App Server 的 start、resume、
fork 也使用同一配置。它们是已验收 Codex 0.144.6 中的实验能力，不写全局配置，
不预先授予文件或网络权限，审批仍使用 `on-request` 和用户审核。未托管且未开启
interactive 的 adapter 保留原默认值。权限表单合并新旧协议字段中的同一路径，
保留不同权限、原字段索引与禁止规则。

turn 完成、中断成功、provider 自行解决请求或 worker 关闭时，待处理请求会失效。
中断后的迟到请求也保持取消，直到下一轮任务开始。直接使用未托管 adapter 时仍
保持拒绝。Claude 使用 `permissionMode: 'default'`，该模式本来允许的工具仍可执行。

问题的直接答案不会写入 HCC 状态快照、事件、投递回执或浏览器存储。表单草稿仅
存在当前页面内存，状态刷新会保留输入与焦点；页面关闭后不保留敏感答案。

本地处理 Codex 权限或问题时，先用 `native requests` 读取原请求，再通过 JSON 文件
提交。以下是两个独立示例，路径、问题 ID 和选项文本必须与原请求一致：

```json
{"permissions":{"fileSystem":{"read":["/requested/read/path"]}},"scope":"turn"}
```

```json
{"answers":{"question-id":{"answers":["原请求中的选项或允许的自由答复"]}}}
```

```sh
hcc native respond --peer codex-reviewer --request REQUEST_ID --decision accept --response-file ./response.json
hcc native respond --peer codex-reviewer --request REQUEST_ID --decision cancel
```

响应文件只允许 `permissions`、`scope`、`answers`。不能添加原请求没有的路径或
网络权限；授予文件权限时必须保留原请求的 deny 条目。所有问题都需明确回答；
请求参数被截断时，只能拒绝或取消。动态工具与账号 token 刷新尚未接入。

Codex MCP 工具审批使用 `mcpServer/elicitation/request`，与命令/文件审批的返回结构
不同。HCC 对显式 MCP 工具确认提交单次 action/content，不写入 session/always 授权。
任意表单字段和 URL 身份认证尚不支持批准，可明确拒绝或取消。

## 当前边界

- 尚未实现接管或 attach 已有 Codex/Claude/dsh TUI、桌面会话；这些会话继续使用原
  transport。
- Web 可发现并控制同一项目的现有 native worker，提供消息、回执、中断和明确关闭。
  关闭页面或 Web runtime 保留独立 native worker；支持与当前执行器、turn 绑定的人工应答。
  使用方式见 [Web 继续本地任务](web-handoff.zh-CN.md#本地-native-worker-接手)。
- Codex、Claude 和 dsh native worker 自动获得项目与 peer 受限的 HCC MCP；
  发信等写入仍须满足 provider 权限与 HCC 所有权检查。
- provider 内置 `SendMessage`、subagent/team discovery、Codex delegation 工具没有
  被暴露为统一的跨厂商协议；跨 provider 消息仍由 HCC 持久总线和 adapter 路由。
- 任务领取、文件锁、交接、完成核验仍是显式 HCC 协作操作；一次 prompt 成功不能
  证明任务已获业务验收。
- adapter 和 stdio fixture 测试验证协议与交互边界；下方真实模型回执单独证明
  模型执行和 MCP 通信。已发布客户端安装、真实业务任务验收仍需独立证据。


## 真实模型验收（2026-10-02）

已在独立临时项目、独立 provider 状态目录中，用现有认证分别完成：

- Codex 0.144.6、Claude Agent SDK 0.3.287、DSH 0.2.0-rc.2 的真实消息往返、回复关联、ACK、重复 submission 去重、连续上下文、关闭后恢复，以及活跃 turn 中断。
- Codex 实际命令审批被拒绝后，权限边界外的测试文件没有创建。
- 模型通过受限 HCC MCP 发信的 `Codex → Claude → dsh → Codex` 三段链路：接收方模型回复、回信消费及 ACK，不生成自动回复循环。
- Web bridge 发现真实 native worker、通过原 runtime 发信、保留原 provider binding；关闭 bridge 后 worker 继续运行。Claude 延迟初始化的恢复状态已有回归测试。

会话生命周期回执 (源码目录: `docs/verification/2026-10-02-native-live-lifecycle.json`) 与
跨 provider 通信回执 (源码目录: `docs/verification/2026-10-02-native-live-communication.json`)
分别记录验证时间、调用数量、源码摘要、真实 session/turn 和清理结果。它们是两个
独立快照；协议模拟测试、真实模型回执、发布安装与业务任务验收各有自己的边界。

本地验证汇总 (源码目录: `docs/verification/2026-10-02-native-live-validation.json`)记录全量单测
（785 项通过、1 项平台条件跳过）、63 个模块静态检查、13 阶段回归与脚本失败路径清理。
这些记录保留各次执行的时间与摘要。

可重复脚本为 `scripts/native-live-acceptance.mjs`。默认只显示帮助，不调用模型；
显式加 `--run-live` 后才使用现有认证，测试过程会调用模型并消耗相应额度：

```sh
node scripts/native-live-acceptance.mjs --run-live --provider all \
  --codex-bin /absolute/path/to/codex \
  --dsh-bin /absolute/path/to/dsh \
  --claude-sdk /absolute/path/to/claude-agent-sdk/sdk.mjs \
  --permission-probe --cross-provider \
  --output /absolute/path/to/receipt.json
```

仅测试跨 provider 通信可加 `--communication-only`。Claude SDK 路径用于显式加载
已安装的独立 SDK；本次真实验收用了此注入路径，没有代替默认安装位置的验收。
脚本不安装依赖、不接管现有会话；结束时关闭测试进程并移除测试凭据副本。
Web 验证覆盖服务与 bridge 控制接口，尚不等于完整浏览器操作或已发布客户端验收。


真实模型与浏览器人工交互可使用 `scripts/web-native-interaction-acceptance.mjs`。
默认只显示帮助；`--run-live --provider codex|claude|all` 才调用模型。
设置 `HCC_ACCEPTANCE_PLAYWRIGHT`，以及按需设置 `HCC_ACCEPTANCE_CHROME`。
`--claude-package DIR` 可将已经安装的 SDK 包链接到隔离 worker 项目，由默认加载器
解析，不注入 query 函数。脚本验证明确批准与拒绝、原会话续接，退出后关闭测试
进程并清理临时 provider home；使用现有认证和调用额度。它不连接现有用户会话。
