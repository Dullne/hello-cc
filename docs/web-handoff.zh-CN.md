# Web 新建 Agent、文件预览与继续本地任务

Web 可以直接新建 Codex、Claude 或 DeepSeek Harness 后台 Agent，也可以继续同一项目中已有的 native worker 或受管终端。

## 浏览文件与产物

选择项目后，点击顶部“文件”，即可浏览项目目录并打开已保存的文件，无需先创建 Agent。
支持逐层进入目录、返回上级、输入项目相对目录和刷新。会话中“引用与执行器能力”的文件
检索结果也可以直接打开预览；“引用文件”仍然只在消息草稿里加入路径标记。

| 文件类型 | 预览方式 |
| --- | --- |
| 文本、源代码 | 显示转义后的原文 |
| Markdown | 显示基本排版与代码块，可切回源码 |
| HTML | 隔离的静态预览，可切回源码；脚本、表单、导航和外部资源不运行 |
| PNG、JPEG、GIF、WebP | 图片预览 |
| PDF | 浏览器内置查看器；未支持内嵌显示时可下载查看 |
| SVG | 仅显示源码 |
| 其他二进制文件 | 提示暂不支持预览，不尝试按文本显示 |

预览只读取当前项目内的普通文件，不修改文件，也不会把内容上传给模型。
`dist`、`build` 等产物目录可以浏览；运行状态、依赖缓存及已知凭据路径不提供预览，
符号链接和硬链接也不读取。目录每次最多显示 500 项，并提示未完整列出的情况；
文本超过 1 MiB 时只显示前部并标记截断，截断 HTML 只显示源码。图片和 PDF 最大为
10 MiB，超过限制会明确提示。文件在读取期间变化时，请刷新后重试。

切换文件、切换项目或关闭预览会使旧请求失效。手机可在目录与预览之间返回切换；
分屏辅助窗口的文件入口会在同一项目的主窗口中打开。此入口暂不包含附件上传、
在线编辑或运行生成网页所需的开发服务器。

## 新建后台 Agent

运行 `hcc web`，选择项目，再点击“新建 Agent”。选择 Codex、Claude 或 DeepSeek Harness 后，默认使用“后台 Agent”；无需预先运行 `hcc native start`。对应 CLI 或 Claude SDK 仍需已安装，身份认证沿用运行 hello-cc 的环境，Web 不代为安装或登录。

工作目录默认当前项目，可改为项目内的子目录；worker 仍共享所选项目的任务、消息、锁和交接。需要在另一个项目工作时，先切换或添加该项目。模型为可选项，留空使用 provider 当前配置；填写时应使用该 provider 支持的模型值。名称可留空自动生成。

此入口只新建 native worker，暂不提供 native resume。既有 `hcc native start` 和 `--resume last` CLI 继续可用。创建后在同一 Web 会话内发送提示、查看回执和处理审批；创建成功不代表已经运行模型任务。关闭页面或停止 Web runtime 都不会停止独立的 native runtime/worker，需要明确执行关闭操作。

“高级选项”保留终端 CLI、Codex 的结构化 App Server 及它们原有的恢复流程。Shell 使用终端，DeepSeek Harness 使用后台 Agent。以下交接说明分别适用于这些执行方式。

## 继续已有终端

CLI/tmux 适合继续已经托管的本地 Codex/Claude/shell：Web 打开同一个 pane，不另起执行器。

运行 `hcc web` 后选择已有会话。选中项和未发送草稿按项目保存于当前浏览器；刷新会恢复原位置。第一个 Web 连接取得控制，其他窗口可观察，点击“接管浏览器控制”后才可写入。服务端检查控制 epoch，旧窗口不能继续输入、改变终端尺寸、修改该 peer 或处理审批。本地 tmux client 仍可直接输入，Web 会显示其连接状态。

终端草稿“发送 + Enter”收到回执，只代表运行时已接受字节。若连接中断或没有回执，草稿保留且不自动重发；先核对终端再决定是否补发。浏览器存储不可用时退回内存，关闭浏览器后未必保留。

关闭页面或“释放控制”不会终止本地执行器。“暂停 Web 接管”使 tmux 保持运行，并保存暂停状态，自动发现和 runtime 重启不会立即重新接入。需要恢复时显式连接已有终端，例如 `hcc peer attach codex-a --pane %1`。暂停不是释放 task owner 或项目锁。选择终止 tmux 的复选框才会同时结束它；PTY 和 App Server 的“终止执行器”会结束对应子进程。

## Codex 结构化界面

在“新建 Agent”中选择 Codex，展开“高级选项”并选择结构化 App Server。需要本地已安装且支持 App Server 的 `codex`，登录和模型环境来自启动 hello-cc 的进程。hello-cc 不自动登录、不更改信任配置、不探测未公开的 TUI 内部 endpoint。

可先运行 `hcc doctor --codex --json` 查看只读诊断。它分别报告已安装版本、CLI help 声明的 App Server 启动参数、hooks 配置与项目中的 hook 调用记录；这些事实不等于完整 RPC 能力、hooks 已受信任、stdout 投递成功或模型已接收。版本/help 探测使用独立临时 HOME/CODEX_HOME 并清理，防止 Codex 启动文件触碰用户目录；hooks 配置仍从原路径只读检查。没有充分回执的状态显示 `unknown`，不会自动触发 hook 或修改 trust。普通 `hcc doctor` 仍只检查数据库。

升级 Codex 前可运行 `npm run codex:protocol -- --codex-bin /absolute/path/to/codex --out /tmp/hcc-protocol-new`。输出目录必须不存在；工具使用隔离 HOME/CODEX_HOME 生成官方 TypeScript 和 JSON Schema，记录版本/文件指纹并检查交接所依赖的协议子集。不兼容时返回非零退出码，未接入请求单独列出；生成成功不代表真实模型或外部授权验收。安装包内也可直接运行 `node /absolute/path/to/hello-cc/scripts/codex-protocol.mjs`。详见 `docs/codex-protocol.md`。

结构化界面提供消息、当前 turn 状态、追加指令、轮次中断、计划、差异和人工交互。命令/文件审批以及空表单 MCP 工具确认由当前控制窗口明确批准本次或拒绝。文件与网络权限可逐项勾选，并明确选择本轮或会话有效期；只能授予原请求的子集。问题支持选项、其他/自由输入和敏感答案，需逐题明确填写。接管控制本身不会批准工具。

表单输入与焦点会跨状态刷新保留，直接答案不写入 HCC 状态、事件、回执或浏览器存储。原 turn 完成、中断成功、provider 解决请求或执行器关闭后，请求卡片失效；旧控制窗口不能用过期 epoch 应答。参数被截断时只能拒绝或取消。MCP 支持下述标准表单和带原 thread/turn 标识的 URL 请求；嵌套对象、任意数组等复杂结构、动态工具及账号 token 刷新尚未接入。

MCP URL 请求显示授权目标，当前控制窗口点击“打开授权页面”后，原执行器接受请求才跳转。弹窗被拦截时不提交请求；过期请求不会打开授权地址。仅允许 HTTPS 或 loopback HTTP，链接带用户名/密码、其他协议、请求标识缺失或参数截断时保留拒绝/取消入口。loopback 地址需在执行器所在电脑打开，其他设备无法通过 HCC 代理本地授权页。

打开页面只表示同意发起外部流程，不表示认证成功。请在外部页面完成操作，再返回关注原任务结果；新页面不保留 opener/referrer。URL、设备码消息和元数据不进入 HCC 交互事件或浏览器存储，实时待处理请求仍可供控制窗口查看。账号登录、token 刷新和 OpenAI 用户验证扩展不包含在此能力内。

运行中发消息使用 steer；空闲时开始新 turn。中断当前轮与终止执行器是不同操作。turn 完成不自动把 hcc task 标记为验收完成。

要恢复一个旧 Codex thread，先停止旧执行器，选择 resume 并填写真实 thread ID，再勾选交接确认。后端仍会验证旧 owner 状态；活跃或证据不明时拒绝恢复。不能把它当作正在运行的 CLI 任务无缝迁移。原 thread 已绑定 hcc peer 时，保留原 peer/task 身份；正在运行的命令和未持久化事件不会迁移。

提交先持久记录 submission ID。重复 ID、断线和超时不会触发自动重发。若读取历史仍不能明确确认接收结果，界面阻止新 turn；停止旧执行器后再恢复保存的 thread。历史清理保留用于去重的最小提交记录。

关闭浏览器后 App Server 仍由 hello-cc runtime 管理；停止 runtime 会关闭它。新 runtime 不会自动重启 App Server 或重放未确认消息，可以从已保存 thread 显式恢复。

MCP 标准表单可以直接在 Web 填写文本、数值、是/否和单选/多选；两种执行器共用校验，答复仍回到同一请求。状态刷新保留页面内的填写内容，可选项不自动发送默认值；页面重载会清空答复。未支持的模式或结构会说明原因，保留拒绝/取消入口。实现和验收范围见 `docs/verification/2026-10-02-mcp-form-web-validation.md`。

真实模型复现脚本为 `scripts/web-mcp-form-live-acceptance.mjs --run-live`：先由本地 Codex 实际发起 MCP 交互，再从桌面/手机 Web 提交，核对同一 native 执行器继续完成和交回本地；另覆盖 Web-owned App Server。环境变量与隔离/账号范围见 `docs/native.zh-CN.md` 的真实模型与浏览器验收说明。成功以该次回执为准，默认运行只打印帮助，不调用模型。

## 本地 native worker 接手

已有 worker 可以继续从 CLI 启动，例如 `hcc native start --peer codex-worker --provider codex`，再打开 Web 的同一项目；也可直接使用上方的新建入口。Web 自动发现实际仍由 native runtime 持有的 worker，显示其原 peer/session、事件和投递回执；接手已有 worker 后的发送、中断和明确关闭都通过原 runtime 执行，不另建 provider 子进程。Claude/dsh worker 也走这条路径，按实际能力显示中断操作。

发送成功先显示队列回执；执行器接收、运行和完成分别使用实际投递状态。断线或不确定结果保留 submission ID，刷新不会重放消息。native runtime 重启或 worker 被替换时，旧 Web 视图及其控制凭证失效，重新发现当前 worker 后才能操作。

关页面或停止 Web runtime 不会停止独立 native runtime/worker。界面的“终止执行器”才会明确关闭该 worker。Codex native worker 提供同一套权限与问题表单，并在会话内显式启用相应的实验工具开关；Claude 通过 SDK 工具 callback 批准原始输入本次执行，dsh ACP 只选择 provider 提供的 allow_once。所有请求均绑定当前执行器/session/turn，不自动批准。

回到本地后，用 `hcc native requests --peer codex-worker` 查看待处理请求，再用 `hcc native respond --peer codex-worker --request REQUEST_ID --decision accept|decline|cancel` 应答。权限或问题答复通过 `--response-file JSON` 提交，格式见 [Native 指南](native.zh-CN.md#会话所有权hooks-和权限)。

## 历史、协作工具与结果审阅

项目栏“Codex 历史”可分页浏览当前项目已保存的 thread，读取上下文，再显式恢复或分叉。恢复仍要求旧执行器已确认停止；分叉生成新的 thread/peer，原任务 owner 不变。有正在托管的源会话时，分叉也必须取得该会话的浏览器控制。历史读取不会启动模型 turn。

Web 专用 Codex App Server，以及由 HCC 托管的 Codex/Claude/dsh native worker，自动接入 [项目与 peer 受限的 MCP 协作工具](mcp.zh-CN.md)。配置只传给对应执行器或 worker，不写全局 provider 配置；关闭 worker 前撤销其临时权限。模型可查询任务与 inbox、领取任务、发送消息、写 handoff、获取/释放自己的资源锁和记录本地证据；不替用户执行发布或业务验收。

会话栏“结果审阅”汇总结构化 command 的执行状态与退出码、是否有 turn 差异、模型通过 MCP 明确提交的本地证据，以及人工添加的验收记录。自动结果仅在实时观察到新 turn 开始后归属当前任务；缺失该事件时，不会从历史快照补认任务证据。自动结果在项目数据库 events 中只保存中性标题、状态、退出码和来源 ID，不保存命令、输出或差异正文；正文仍可在可用的执行器会话或 provider 历史中查看。命令退出成功仅说明该命令成功；人工填写“通过”必须附证据引用。界面分别展示本地验证、发布部署、业务验收，并注明记录来源。turn 完成、测试记录或人工验收均不自动改变 hcc task 状态。`gc --history` 保留结果审计记录和最小提交去重凭据。

## Codex 账号与限额

Web 专用 Codex 和原生 Codex worker 新增只读“账号与限额”面板，观察窗口也可刷新。它显示本执行器的登录/供应商认证状态、可获取的订阅窗口、重置时间和读取时间；缺失或不支持的配额保持未知，账号切换与执行器替换拒绝旧查询结果。此操作不新建任务或 turn，也不提供登录、退出或 token 管理。未登录时需在运行任务的电脑完成本地 Codex 登录。使用方式、接口身份和真实/模拟验收边界见 [账号与限额说明](codex-account.zh-CN.md)。

## 验收边界

以下既有记录分别对应当时的执行器、交接和交互流程，不代表新增的统一“新建 Agent”入口已完成真实模型或发布验收。

本地验证包含真实 SQLite/HTTP、模拟交互请求、隔离 tmux 与桌面/手机浏览器。安装版 Codex 0.144.6 的协议验收另行覆盖 initialize、thread/start/list、10 个 MCP 工具发现和实际 `hcc_state` 读回；此协议检查不调用模型，可用 `node scripts/web-handoff-installed-acceptance.mjs` 重现。

真实模型验收已在隔离项目和 Codex home 中完成“本地 → Web → 本地”三段文件任务，全程保持原 Codex 进程和 thread；关闭 Web runtime 后仍可继续。可用 `scripts/web-native-model-acceptance.mjs` 在明确需要真实模型调用时重现。三种 provider 的真实生命周期、模型 MCP 发信、回复/ACK 和无回复循环另有独立回执。交互表单另有 11 项模拟 provider 浏览器检查。真实 Codex 已经完成“提问 → Web 答复 → 指定文件权限 → 本轮授权 → 写入所选答案 → 后续请求拒绝 → 本地继续”的验收；默认加载的 Claude SDK 已完成真实 Write 工具批准、拒绝和本地续接。dsh 已完成真实 ACP 写入的 Web 批准、拒绝和原 session 本地续接，审批卡片另通过桌面与 390px 手机检查；仅在隔离 profile 中对指定验收文件设置公开审批策略。完整结果与运行条件见 本地验收记录 (源码目录: `docs/verification/2026-10-02-web-local-task-handoff.md`)。

任意未托管 TUI/普通终端的活动执行器迁移、私有 daemon endpoint、任意协议版本的完整兼容矩阵，以及发布安装和真实业务验收仍在本次证据范围之外。
