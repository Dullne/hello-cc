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

## Runtime 所有权与目录身份

Runtime 保留原有 file-lock owner 保护，并增加持久化的 SQLite owner 校验。
owner 保存 runtime generation、mesh 数据库、私有状态 generation、根目录身份
以及进程 PID、启动标记和命令哈希。Native 写入及派生 hook/scoped MCP 写入在
同一个 writer fence 中复核 owner。存活或无法核实的 owner 阻止接管；后继进程
只能接管已释放或已证实退出的 owner。目录替换或旧执行器 capability 不能授权
写入后继状态。

旧 runtime pointer 缺少目录身份回执或 owner fence 时分别被
`PROJECT_PATH_CHANGED` 或 `NATIVE_OWNER_UNVERIFIED` 拒绝。
先用正在运行的旧版本停止它，确认退出后再启动新版本。Native provider 子进程
通过其 scoped HCC MCP 工具协作；在该环境中直接调用普通 `hcc` 命令会收到
`NATIVE_CLI_SCOPE_REQUIRED`。原 sandbox policy 和 expected runtime generation
规则继续生效。v1 绑定升级回执和替换目录分代见
[项目目录身份与私有状态](private-state.zh-CN.md)。

## 会话 fork 与原 ID 重试

`hcc native fork --parent codex-reviewer --peer codex-branch` 使用 provider 自身的
会话 fork。Codex 通过 `thread/fork`，Claude 通过可选 SDK 的 `forkSession` 创建
新的会话 ID；子 worker 有独立 executor、消息投递记录和后续历史，策略允许 HCC
工具时也有独立 MCP scope。
父会话仍保留原身份；关闭子 worker 后可用 `native start --peer codex-branch
--provider codex --resume last` 恢复子会话。fork 继承父会话的工作目录，并复核目录
身份，不复制父 worker 的未决 inbox 或权限批准。

只能 fork HCC 持有且保存了会话 ID 的 native worker。父 worker 必须空闲或已明确
关闭，无活动 turn、待审批请求、排队或结果不明的投递；fork 期间暂停父 worker
的发送、关闭和 inbox 分发。已有 TUI/Desktop 会话不在此范围内。Claude SDK
缺少 `forkSession` 时明确报不支持。DeepSeek Harness 0.2.0-rc.2 的 ACP 实现未提供
fork；HCC 不用 transcript 重放冒充原生 fork。

每条新消息可指定唯一的 `--submission-id`，格式为 8–100 个英文字母、数字、下划线
或连字符。遇到回执丢失时先查 `native deliveries`，然后对同一 worker、sender、task
和正文沿用原 ID 重试。相同 ID 返回原持久回执，正文或目标变化会被拒绝。项目
数据库同时保存消息和 submission ID；若消息已提交而 native 投递记录尚未写入，
重试或 worker 恢复会补齐原记录，保留用户请求来源。已有 `uncertain` 投递不会
因为重试被自动重放。

Web 遇到未确认提交时提供“沿用原提交重试”。此操作需核对持久回执后明确确认，
并保持原执行器身份与原正文；之后编辑的草稿会保留。执行器或项目变化时禁用原
提交重试。没有匹配的持久 pending 记录、或原消息已被清理时拒绝重试；不会把
原 ID 当作新工作发送。

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

## 从 Web 新建

运行 `hcc web`，选择项目，再点击“新建 Agent”。Codex、Claude 和 DeepSeek Harness
默认使用“后台 Agent”，创建 native worker 并按需启动或复用该项目的独立 native
runtime。无需先运行 `hcc native start`；上述 provider 安装和认证要求仍然适用。

顶部“设置”可保存项目默认 provider，以及各 provider 的默认模型和项目内工作目录。
新建表单会预填这些值；未设置工作目录时使用项目根目录。worker 继续共享所选项目的
HCC 任务和消息总线。要在根目录之外工作，先选择或添加相应项目。“模型（可选）”
留空时使用 provider 当前配置，填写时需使用该 provider 支持的模型值；“名称（可选）”
留空时自动生成 peer 名称。

这些默认值只用于后续 Web 新建 native worker，不改变既有 worker、恢复或 CLI 启动。
配置由项目数据库保存，跨浏览器读取；并发保存发生冲突时需重新载入核对。详情见
[项目启动默认值](web-handoff.zh-CN.md#项目-agent-启动默认值)。

“新建 Agent”创建新 native 会话；项目栏“历史”中的“HCC 保留历史”可查看已保存的
worker，并显式恢复已关闭的 worker。恢复保留原 peer 和 provider 会话 ID，重新核对
所有权后启动新执行器。CLI resume 继续可用。“高级选项”保留终端 CLI、Codex App
Server 及各自原有的历史恢复操作。Shell 使用终端，DeepSeek Harness 使用后台 worker。

创建后在同一 Web 会话内发送提示、查看投递回执或处理审批。创建 worker 不代表模型
任务已经完成。关闭页面或停止 Web 都保留独立 native runtime 和 worker；不再需要时
明确关闭 worker。下方带日期的既有验收记录不代表这个新建入口已通过真实模型或发布
验收。详细操作见 [Web 指南](web-handoff.zh-CN.md)。

顶部“文件”可浏览项目文件与生成产物，也可显式上传新文件（最大 10 MiB）或编辑完整
UTF-8 文本（最大 1 MiB），无需创建 worker。同名上传不覆盖，文本保存会检查版本；
冲突或回执不确定时保留草稿。这些操作不会把文件发送给模型。详情见
[文件与产物预览](web-handoff.zh-CN.md#浏览文件与产物)及
[上传与编辑](web-handoff.zh-CN.md#上传与编辑项目文件)。

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

### Codex 文件只读沙箱

```sh
hcc native start --peer codex-readonly --provider codex --sandbox read-only
# 关闭后恢复原会话时继承已保存的策略；不要改成 workspace-write。
hcc native close --peer codex-readonly
hcc native start --peer codex-readonly --provider codex --resume last
```

`--sandbox` 仅支持 Codex 的 `read-only` 和 `workspace-write`。新会话未指定时保持
`workspace-write`；恢复时未指定则继承存储策略，显式不同的策略会被拒绝，需要另建
worker。旧版本记录迁移为原有 `workspace-write` 行为；无权限推断或自动升级。
首次初始化尚未建立会话时，重试默认继承已选择策略，也可显式更改。CLI 与 Web 创建／恢复 Codex worker
前检查后台服务的沙箱协议版本；旧服务不支持时在发送创建请求前拒绝，不自动重启。
创建请求绑定刚核实的 runtime generation；期间实例被替换或身份缺失时拒绝发送，
不会跟随新实例自动重试。
应等项目任务结束后由用户停止旧 runtime，再以新版本启动。不要用旧版本 runtime
读取新版本只读记录：旧代码不了解该策略，回退执行不属于只读保障。
Web 仍可查看或关闭旧 worker；其最新快照不含沙箱策略时，拒绝 Codex 发送和回答审批／问题。
只读 worker 还必须回报 provider 已校验策略，才能执行这两类操作。Web 写请求绑定准入前
刚读取的 runtime generation，不会自动跟随替换实例。

只读模式固定 `approvalPolicy: never`，每个新 turn 显式请求 `readOnly`、关闭沙箱网络，
拒绝命令／文件／权限提升和 MCP 授权表单；普通用户问题仍可回答。启动／恢复要求
provider 回报相符策略，否则关闭自有连接并报错；fork 子会话执行相同校验。已有活动 turn 的只读恢复也拒绝，
不能用新策略为正在执行的旧 turn 作保证。`sandboxVerified` 仅表示 provider 回报匹配，
不是一份操作系统行为证明。

HCC 不为只读 worker 注入自有的任务／锁／结果写操作 MCP，也不提示模型执行 HCC
写命令。HCC 控制面仍保存消息、回复、投递和审计。Codex 的文件沙箱不等于所有外部
服务或用户配置的 MCP／hooks 都只读；严格隔离验收仍须独立 HOME、无外部工具。
它也不同于网页“观察／控制”权限：控制者仍可向只读 worker 发送审阅请求。

此功能自 `1.1.0-rc.4` 起提供。Web 的 native 快照会保留 `sandbox` 与 `sandboxVerified`。
请通过 CLI 选择只读策略。
原生 fork 继承父会话的持久化策略，不能覆盖或提升；子会话启用前会独立校验。

| 命令 | 参数与作用 |
| --- | --- |
| `hcc native up` | 启动或复用本项目后台 runtime |
| `hcc native status` | 查看持久化 worker 状态和 runtime 身份 |
| `hcc native start` | 必须 `--peer NAME --provider codex\|claude\|dsh`；可选 `--cwd DIR --model MODEL --resume last`；`--binary PATH` 仅适用于 Codex 和 dsh；`--sandbox read-only\|workspace-write` 仅适用于 Codex |
| `hcc native fork` | 必须 `--parent NAME --peer NEW_NAME`；可选 `--model MODEL --binary PATH`；复制 HCC 持有的 Codex 或 Claude 会话到新 worker |
| `hcc native send` | 必须 `--peer NAME --body TEXT`；可选 `--from NAME --task ID --submission-id ID`；返回持久消息/submission 回执 |
| `hcc native deliveries` | 可选 `--peer NAME`，查看投递回执 |
| `hcc native events` | 必须 `--peer NAME`；可选 `--after ID`，查看有界事件历史 |
| `hcc native requests` | 必须 `--peer NAME`；查看与该执行器、会话、turn 绑定的待处理请求 |
| `hcc native respond` | 必须 `--peer NAME --request ID --decision accept\|decline\|cancel`；权限子集、问题答案或 MCP 表单内容通过 `--response-file JSON` 提交 |
| `hcc native interrupt` | 必须 `--peer NAME`；可选 `--turn ID`，请求中断活动 turn |
| `hcc native close` | 必须 `--peer NAME`，关闭该 worker 持有的连接或进程 |
| `hcc native down` | 请求关闭 worker 和停止 runtime，返回停止请求回执 |

`native down` 的回执只确认停止请求，不证明关闭已完成。需要检查 `native status`
确认结果。若 provider 关闭失败，HCC 保留 runtime owner，并在
`status.shutdown_error` 报告错误；处理所报问题后，再次执行 `native down`。

事件保留语义输出和完成证据，不把 token delta 持久化为投递回执。runtime 状态位于
`<解析后的项目状态目录>/native/`，可以是项目局部或上方说明的私有状态；协作记录
仍写入所选 HCC 数据库。控制接口是独立于 Web
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

新保存的 worker 还记录工作目录的文件系统身份；即使路径文字未变，恢复前也必须
重新匹配该身份。缺少此证据的旧 worker 仍可在 HCC 历史中读取，但不能自动恢复；
人工核验与关联流程尚未实现。Web 历史会先标为不可恢复，native 服务在实际接纳时
再次校验。

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
| Codex | 命令/文件审批、所请求文件与网络权限的子集、明确的 turn/session 有效期、选项/自由输入/敏感问题，以及单次空表单 MCP 工具确认与常用 MCP 表单字段 |
| Claude | SDK 工具权限 callback，批准原始输入本次执行，不改写工具参数 |
| dsh ACP | 选择 provider 提供的 `allow_once`，不自动选择 `allow_always` |

rc.2 的 ACP 审批可能只携带工具 ID。适配器会关联同一 session/turn 的工具更新以展示操作输入；等待后仍缺输入或输入被截断时可以拒绝，允许会返回 `NATIVE_APPROVAL_CONTEXT_MISSING`。实际安装与拒绝证明见 dsh 验收 (源码目录: `docs/verification/2026-10-02-dsh-cordis-native.md`)。

Native 审批卡片先显示工具、命令或文件路径和内容预览，并明确本次授权范围。
完整操作详情可以展开，状态刷新保留展开状态；ACP 缺少操作输入或单次批准选项
时禁用批准按钮，仍可拒绝。长内容预览会明确提示缩短，完整参数继续可查看。

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

响应文件只允许 `permissions`、`scope`、`answers`、`content`；MCP 表单用 `content` 对象提交原字段名和类型，例如 `{"content":{"project":"demo","count":2,"enabled":false}}`。不能添加原请求没有的路径或
网络权限；授予文件权限时必须保留原请求的 deny 条目。所有问题都需明确回答；
请求参数被截断时，只能拒绝或取消。动态工具与账号 token 刷新尚未接入。

Codex MCP 工具审批使用 `mcpServer/elicitation/request`，与命令/文件审批的返回结构
不同。HCC 对显式 MCP 工具确认提交单次 action/content，不写入 session/always 授权。
标准 `form` 模式支持字符串、数值/整数、布尔值、单选和字符串枚举多选，包含标题、说明、默认建议值、必填项、长度/数值/选择数量范围及常用邮箱/URI/date/date-time 格式校验。可选字段只在勾选填写后发送；布尔值需明确选择是或否。字段数量上限 50、单字段选项上限 100、字符串上限 8192 个 UTF-16 单元，表单结构与应答内容各限 65536 字符。

Web 刷新执行状态时在页面内存中保留填写内容；提交、请求消失或切换会话后清除，不写入浏览器存储、HCC 事件或投递回执。页面整体重载不会恢复这些答复。此约束针对 HCC 的交互应答路径；provider 自身记录及模型输出继续按其原有行为处理。服务端重复校验内容，审批继续绑定原 executor/session/turn/request；错误输入保留请求供修正。嵌套对象、任意数组、未知约束和 OpenAI 扩展表单模式仍不可批准，页面显示原因并提供拒绝/取消。此能力未改变动态工具或 token 刷新的接入边界。

带原 thread/turn 标识的 MCP `url` 请求现在可在 Web 打开授权页面。界面显示 MCP 服务和目标域名，当前控制者明确点击后先保留空白标签页；原执行器接受同一个请求后才跳转，过期或被拒绝的请求会关闭空白页。弹窗被拦截时保留待处理请求，允许弹窗后可重试。仅允许 HTTPS 或 loopback HTTP，拒绝带用户名/密码的 URL、其他协议、缺少 elicitation 标识或被截断的请求；拒绝/取消始终可用。新标签页不保留 opener 或 referrer。loopback 地址需在执行器所在电脑的浏览器访问，HCC 不把本地授权回调代理到另一台设备。

打开只回传 `{ "action": "accept" }`，不代表身份认证完成。需在外部页面完成操作，再返回查看原任务的 provider 结果。HCC 不推测授权完成事件，也不在表单中收集凭证；授权 URL、设备码消息、elicitation 标识和元数据仅存在于实时待处理请求，不留在 HCC 交互事件或浏览器存储中。provider 自身日志/历史和外部授权浏览器仍按各自规则处理。账号登录、token 刷新、`openai/userVerification` 与外部授权完成 API 属于独立的未接入能力。

浏览器复现：设置 `HCC_ACCEPTANCE_PLAYWRIGHT` 指向 Playwright 模块，再执行 `node scripts/web-mcp-form-acceptance.mjs --run-browser`；`HCC_ACCEPTANCE_CHROME` 可指定 Chrome 路径。该脚本用模拟 provider、真实 HTTP/SQLite/native runtime 和隔离浏览器，不调用模型。表单验收见 `docs/verification/2026-10-02-mcp-form-web-validation.md`。

真实模型与浏览器验收使用 `node scripts/web-mcp-form-live-acceptance.mjs --run-live`，同样需要设置 `HCC_ACCEPTANCE_PLAYWRIGHT`，可选 `HCC_ACCEPTANCE_CHROME`、`HCC_ACCEPTANCE_TMUX`、`--codex-bin PATH` 与 `--output NEW_FILE`。默认只打印帮助；显式运行会使用当前模型和账号的额度。脚本让安装版 Codex 调用隔离 stdio MCP 工具，通过实际 Web 操作完成工具确认、字段填写和提交，核对原类型答复、模型文件落盘，以及 Web 关闭后原 native 执行器继续执行；另覆盖 Web-owned App Server 路径，没有注入模型输出或 App Server 请求。

此验收分别隔离 HCC 的用户目录、Codex home、项目、tmux socket 和浏览器 profile。已配置的外部认证辅助程序可在原用户目录下只读运行，以保持当前账号的正常凭据获取；不更改原 provider、模型、登录状态或原配置。回执记录源码摘要、实际检查、清理结果及原配置/认证/shell 配置摘要核对，`--output` 必须使用新路径，既有回执不会覆盖。验收工具日志只包含合成表单值，直接答复不应被误当成真实业务数据。


## 当前边界

- 尚未实现接管或 attach 已有 Codex/Claude/dsh TUI、桌面会话；这些会话继续使用原
  transport。
- Web 可新建 Codex、Claude、dsh native worker，也可发现并控制同一项目的现有 worker，
  提供消息、回执、中断和明确关闭。“历史”提供 HCC 保留事件与已关闭 worker 的显式恢复；
  记录不是 provider 完整历史，活跃或停止未确认的 worker 不可从此入口恢复。
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
默认只显示帮助；`--run-live --provider codex|claude|dsh|all` 才调用模型。
设置 `HCC_ACCEPTANCE_PLAYWRIGHT`，以及按需设置 `HCC_ACCEPTANCE_CHROME`。
`--claude-package DIR` 可将已经安装的 SDK 包链接到隔离 worker 项目，由默认加载器
解析，不注入 query 函数。脚本验证明确批准与拒绝、原会话续接，退出后关闭测试
进程并清理临时 provider home；使用现有认证和调用额度。它不连接现有用户会话。

`--provider dsh --dsh-bin /absolute/path/to/dsh` 使用已安装的公开 launcher 和现有
`DEEPSEEK_API_KEY`。脚本在私有 ACP profile 中通过公开 `tools/pre-execute` 策略
让两个指定验收文件的写入请求审批；审批请求来自真实模型工具调用，不注入 ACP 请求。
验证批准后写入、拒绝后文件不存在、释放 Web 控制后原 session 本地续接，另检查
桌面和 390px 手机审批卡片。真实结果见 dsh Web 交互回执 (源码目录: `docs/verification/2026-10-02-native-web-dsh-final-snapshot-interactions.json`)。


## 安装包验收

`scripts/native-installed-acceptance.mjs` 对已经安装的 HCC 包执行验收，通过公开
`hcc native` 命令启动 daemon 和三个 provider。先把本地包与可选的 Claude SDK
安装在同一个独立 npm prefix；脚本使用 SDK 默认包解析，不注入 adapter 或 query
函数。不加 `--run-live` 只显示帮助，不调用模型。

```sh
npm install --prefix /absolute/path/to/acceptance-prefix \
  /absolute/path/to/hello-cc.tgz @anthropic-ai/claude-agent-sdk

HCC_ACCEPTANCE_PLAYWRIGHT=file:///absolute/path/to/playwright/index.mjs \
HCC_ACCEPTANCE_CHROME=/absolute/path/to/chrome \
node /absolute/path/to/acceptance-prefix/node_modules/@logicseek/hello-cc/scripts/native-installed-acceptance.mjs \
  --run-live --codex-bin /absolute/path/to/codex \
  --dsh-bin /absolute/path/to/dsh --archive /absolute/path/to/hello-cc.tgz \
  --browser --task --output /absolute/path/to/receipt.json
```

验收覆盖三个已安装 provider 的关联回复与 ACK、重复提交、连续上下文、owned
close/resume、中断，以及一次明确拒绝 Codex 越界写入审批。先通过人工控制入口给每个 worker 授权限定任务，再由模型通过 MCP 沿
`Codex → Claude → dsh → Codex` 发消息并消费回复。浏览器检查 SDK 默认加载、
明确批准文件写入、桌面和手机渲染、释放控制权，以及关闭 Web 后原会话本地续接。
`--task` 增加独立文件协作样例：Codex 实现金额计算，通过五个合同测试，再通过
模型发出的交接消息让 Claude 写出审查文件。这个样例与生产业务的用户验收分开。

脚本使用现有认证和调用额度。HCC 全局 HOME、provider home、tmux server 和项目
使用私有验收目录；复制到私有配置中的 Codex 凭据命令，仅在读取现有凭据时保留
原 HOME，原配置保持不变。退出后清理自有进程与临时凭据。回执记录包 SHA-256、
provider 版本、源码摘要、浏览器证据和清理结果；脚本不会发布 npm 包或部署到
员工设备。

通过已认证的 native CLI/Web 控制入口提交的任务，持久记录为人工请求；共享 HCC
消息总线送达的内容保持 peer 消息身份，即使发送方自称 `web` 或 `shell`。旧回执
迁移后仍按 peer 消息处理。来源区分不授予工具权限，写入等受控操作仍需审批。
委派文件任务时，先由用户明确授权接收 agent 的限定任务，再发送 peer 交接。

## 有界稳定性验收

安装包验收可加 `--stability`，在基础生命周期和跨 provider 通信之后运行持续负载：

```sh
node /absolute/path/to/acceptance-prefix/node_modules/@logicseek/hello-cc/scripts/native-installed-acceptance.mjs \
  --run-live --codex-bin /absolute/path/to/codex --dsh-bin /absolute/path/to/dsh \
  --archive /absolute/path/to/hello-cc.tgz --stability \
  --stability-cycles 6 --stability-burst 2 --stability-idle-ms 30000 \
  --stability-resume-every 2 --output /absolute/path/to/stability-receipt.json
```

三个 provider 同时工作，每轮先向各 worker 排队投递整组消息。每条要求模型从
历史中回忆原始随机标记和上一条消息的票据，验证串行处理顺序与上下文保留。
每轮还重复提交同一提交 ID，核对只产生一条回复与一个 ACK；定期关闭并恢复
worker，在中点正常重启自有 daemon，再验证原 session 和历史。空闲窗口继续
检查控制接口、pending 请求与会话身份。结束时核对持久投递、数据库完整性、
事件保留上限与无回复循环。回执保留每条实际回复、失败状态和自有进程内存
采样，不自动重放失败任务，也不把同轮重新尝试改写为成功。

默认 6 轮、每 worker 每轮 2 条、每轮空闲观察 30 秒、每 2 轮恢复。参数限制为
1–24 轮、1–4 条、0–300000 毫秒和 1–24 轮恢复间隔；这些选项必须与
`--stability` 一起使用。这是有界真实模型负载验收，不能代替 24 小时 soak、
并发容量测量或内存泄漏证明。DSH 单次恢复成功也不能单独解释历史恢复波动。

`--stability-only` 与 `--stability` 一起使用时，只建立三个真实会话并运行稳定性
负载，跳过基础中断、命令审批和模型 MCP 通信场景；回执明确标记该范围。
适合已有独立生命周期/交互回执时单独补做持续负载，不能把跳过项算作通过。
发生任一错误时，脚本在关闭自有 worker 前保存会话快照、最近投递和事件。
