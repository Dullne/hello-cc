# Web 接手本地任务：本地验收记录

实现与协议基线：2026-10-02；续验执行时间以回执的 UTC 时间戳为准。Node.js 24.19.0，macOS arm64；安装版 Codex 0.144.6。协议参考源码基线为 `openai/codex` 的 `14a477ea89712071944244022e8a10142845456e`，不代表任意版本的完整兼容保证。

## 已实现

- 托管 tmux 会话复用原 pane；Web 草稿、字节回执、控制租约/epoch 和暂停接管状态均已接入。停止 Web 接管保留本地执行器、任务 owner 和锁；本地 tmux 键盘仍可直接输入。
- Web 专用 Codex App Server 提供结构化消息、steer/interrupt、计划、差异、项目历史分页及显式 resume/fork。不确定提交持久去重，不自动重放。
- 独立 native runtime 的 Codex/Claude/dsh worker 可在 Web 中查看、发送、中断和明确关闭，复用原执行器。runtime generation、worker owner、provider session 及浏览器 epoch 使过期视图失效；停止 Web 保留 native worker。
- Web 专用 App Server 与三种 hosted native worker 自动获得 10 个项目/peer/worker 受限的 MCP 工具。capability 在启动前建立，关闭或启动失败清理前撤销，不写全局 provider 配置。
- 人工交互接入 Codex 命令/文件审批、权限子集与明确 turn/session 有效期、选项/自由输入/敏感问题，以及单次空表单 MCP 工具确认；在托管会话内显式开启模型侧相应实验工具，合并同一路径的新旧协议授权项；Claude SDK 工具审批使用原始输入，dsh ACP 仅选择 allow_once。Web 与本地 `native requests/respond` 共用原请求身份。
- native 审批卡片优先展示工具/命令、文件路径与转义内容预览，保留完整操作详情并跨刷新保持展开状态；上下文不完整的 ACP 操作禁用批准，仍可拒绝。
- 请求在 turn 完成、成功中断、provider 自行解决或关闭执行器后失效；中断后的迟到请求不能重新打开审批。表单草稿与焦点跨状态刷新保留，直接答案不进入状态、事件、回执或浏览器存储。
- 结果审阅保存命令、退出码、输出、差异与人工证据，区分本地、发布和业务阶段，不自动完成任务。结果和最小去重回执受到 history GC 保护。
- `doctor --codex --json` 区分版本、CLI 声明的启动参数、hooks 配置与 hook 调用记录。stdout 投递、provider 接收和 trust 缺乏回执时保持 unknown；普通 doctor 保持数据库检查语义。

## 本轮本地验证

本轮审批体验、真实 dsh 浏览器交互、fixture 修复和最终回归的源码摘要保存在[最终审批与续接验证回执](2026-10-02-native-web-final-validation.json)，并保留[上一验收检查点](2026-10-02-native-web-approval-validation.json)。此前的[交互验证回执](2026-10-02-web-interaction-validation.json)和[dsh 原始交互回执](2026-10-02-native-web-dsh-interactions.json)保持原样，分别代表当时的源码。

| 检查 | 结果 | 入口或证据 |
| --- | --- | --- |
| 固定快照全部单元与集成测试 | 900 项：899 通过、1 项 Linux proc 条件跳过、0 失败 | `npm run test:unit`；`/tmp/hcc-native-preview-snapshot-GYNKVY-unit.log` |
| Factory 自由标识符检查 | 63 个模块通过，保留已注明的扫描器豁免 | `npm run test:audit`；快照及当前受影响模块补验均通过 |
| 固定快照 CLI/runtime/tmux 回归 | 13 个阶段通过，`FULL_REGRESSION_OK` | `/tmp/hcc-native-preview-snapshot-GYNKVY-regression.log` |
| 固定快照浏览器人工交互 | 11 项通过；零 page error、console warning/error | `/private/tmp/hcc-interactions-ui-e0KoMn/evidence.json`；`/tmp/hcc-final-snapshot-ui-interactions-qa.log` |
| 固定快照真实 dsh Web 交互 | 5 项通过：操作摘要与刷新详情、批准后写入、拒绝后不写入、原 session 本地续接、无浏览器错误 | [dsh 快照交互回执](2026-10-02-native-web-dsh-final-snapshot-interactions.json) |
| 文件锁/tmux fixture 并发压力 | 4 组独立套件，各 34 项；共 136 通过、0 失败 | `/tmp/hcc-native-timeout-fixture-stress.json` |
| 最终快照前的相关模块补验 | 13 个相关测试文件，共 169 项通过；运行期间源码未变化 | `/tmp/hcc-current-native-delta-validation.json`；范围与摘要见汇总回执 |
| 真实模型本地 → Web → 本地 | 三段通过，同一 Codex 进程与 thread，关闭 Web 后仍可继续 | `scripts/web-native-model-acceptance.mjs`；`/tmp/hcc-live-handoff-acceptance.log` |
| 三种 provider 真实生命周期 | 消息往返、回复关联/ACK、去重、连续上下文、关闭/恢复、中断通过；Codex 实际命令审批被拒绝且外部测试写入未发生 | [生命周期回执](2026-10-02-native-live-lifecycle.json) |
| 模型自主 scoped MCP 通信 | Codex → Claude → dsh → Codex 三段发信、模型回复、回信消费/ACK、无自动回复循环通过 | [跨 provider 通信回执](2026-10-02-native-live-communication.json) |
| 真实 Codex Web 提问与权限 | 原轮次问题答复、精确文件权限的本轮授权、写入所选答案、拒绝后无写入、本地原 thread 续接通过 | [真实交互回执](2026-10-02-native-web-codex-interactions.json) |
| 默认 Claude SDK + Web 工具审批 | SDK 默认项目依赖解析，无 query 注入；真实 Write 的批准、拒绝与原 session 本地续接通过 | [默认 SDK 回执](2026-10-02-native-web-claude-default-sdk.json) |
| 安装版 Codex 协议/MCP | initialize、thread start/list、10 个工具发现、实际 hcc_state 读回匹配 peer | `scripts/web-handoff-installed-acceptance.mjs`；`/tmp/hello-cc-installed-mcp-acceptance.log` |
| 安装版只读诊断 | 0.144.6、--listen stdio://；默认 doctor 不探测 Codex；隔离启动文件与清理通过 | `scripts/codex-diagnostics-installed-acceptance.mjs`；`/tmp/hello-cc-installed-diagnostics-acceptance.log` |

最终固定快照为 `/private/var/folders/w2/xwv9k9950t7d3v8t_h2l0gjc0000gn/T/hcc-native-preview-validation-GYNKVY`，复制时与当前工作区源码一致。快照的审计、900 项全量单测、13 阶段回归、桌面/手机浏览器和真实 dsh 验收均保持相应源码不变；全部执行完成后逐文件核对，工作区仍与该快照一致。原始清单和日志摘要见[最终快照回执](2026-10-02-native-web-final-snapshot.json)。

较早的 `0wseLN` 快照有 888 项单测、887 通过；其第一次回归在旧名称扫描时因缺少 `.git` 失败。补入隔离 Git 元数据及原工作区 222 个 tracked 路径后，同一源码通过完整回归，原失败日志和回执保留。最终快照在测试前准备好这份隔离 Git 元数据，未修改原工作区 index。

在最终快照之前，曾对后续改动完成 169 项补验，覆盖 dsh Cordis、native store/runtime、结果审阅、Web 会话与控制、UI 和私有文件权限。最终快照已包含这些改动，并再次通过全量审计、单测和回归；169 项是修复过程的补充证据，不与 900 项累计相加。较早回执只代表各自记录的源码摘要，不能替代最终快照的证据。

此前并行运行全量单测与回归时出现过文件锁和模拟 tmux 的 5 秒 fixture 超时，原日志 `/tmp/hcc-interactive-default-concurrent-unit-failure.log` 保留。文件锁的注入缺口已确定性复现：最后一个候选端口被无关监听器占用时，ACQUIRED 从身份探测回调发布，原 fixture 仅在成功 listen 回调注入失败，因而永远等不到注入。现在通过 `Atomics.waitAsync` 观察共有状态，覆盖两条获得锁的路径并核对碰撞分支计数；修复前复现日志和修复后 34 项目标测试、136 项压力测试均有回执。模拟 tmux 改用 shell fixture，保留参数记录，减少每次探测的 Node 启动开销；历史 tmux 超时的精确根因仍未证明。两处生产时限与文件锁生产代码均未更改。

另将 tmux stream 的过时源码文本断言替换为实际行为测试，验证 session 所属项目和 runtime 项目回退、FIFO 0600、buffer 目录 0700，以及其他项目不受影响；与私有状态权限测试共 16 项通过。回归中旧创建表单字段检查限定在 `startForm`，审批卡片合法的 Working directory 标签不会再触发误报。

浏览器运行于 127.0.0.1 的隔离动态端口，使用已安装 Chrome、独立 profile 和 bundled Playwright，桌面 1440×1000、手机 390×844。当前会话没有 Browser plugin，因此采用 Playwright。11 项检查覆盖页面身份、非空白、无错误覆盖层、观察者禁止审批、预览转义、审批后卡片移除、权限子集与本轮范围、未回答问题保留、选项/其他/自由输入/敏感答案、刷新保留草稿与焦点、答案不入存储、接管控制后旧窗口失效、手机无横向溢出，以及 Web-owned App Server 的实际 JSON-RPC 响应。该组请求由模拟 provider 产生，使用真实 SQLite/HTTP/native bridge。

真实 dsh 组使用安装版 `0.2.0-rc.2` 公开 launcher 与现有认证，在隔离 ACP profile 中仅对两个验收文件配置公开 `tools/pre-execute` 审批策略。模型实际调用 write 产生原始权限请求，没有注入 ACP 请求。桌面显示工具、路径、转义内容预览及本次范围，完整参数可展开，刷新保持展开状态；手机通过面板滚动访问批准与拒绝控件。缺失/截断 ACP 操作输入或没有单次批准选项时禁用批准，拒绝保持可用。批准写入 `DSH_APPROVED_OK`，拒绝的文件不存在，交回本地后保持原 session，退出后测试进程关闭、provider home 清理，原 Codex config/auth 摘要未变化。桌面和手机截图均已查看。

先前另有 15 项扩展浏览器检查通过，证据为 `/private/tmp/hello-cc-ui-extra-qa-IgzPdE/evidence.json`，包含一条预期断网注入的 network console error；与本次 11 项和真实 dsh 5 项分开计数。

本轮修复还包括：共享权限/问题校验及 native 请求生命周期；Web 与本地应答身份校验；三种 worker 的 scoped MCP 注入与撤销；语义 command/file/MCP、plan/diff 事件；表单刷新时焦点恢复的空值错误；macOS PATH 不含 sysctl 时对 `/usr/sbin/sysctl` 的受控回退；以及 Claude/ACP 中断成功后的迟到请求取消。原先搜索测试补齐模板要求的 CSP nonce，dsh detected 测试正确计入三个 dsh 加一个 Claude，真实 shim 测试为并发 Node 启动使用独立有界时限，生产诊断仍保留 2 秒时限和 unknown 语义。

## 真实模型证据与范围

连续任务使用当时配置的 `gpt-6.1-sol`。本地读取 41 后写入 42 和 `[local]`；真实浏览器续写为 43 和 `[local, web]`；释放控制、关闭 Web 并执行 `hcc down` 后，本地原 worker 续写为 44 和 `[local, web, local-return]`。三段 PID 均为 49637，thread 均为 `01a0fc8f-dc75-7a31-884d-0ed3635cd753`，原 config/auth 文件摘要保持不变。

连续任务原始证据为 `/private/var/folders/w2/xwv9k9950t7d3v8t_h2l0gjc0000gn/T/hcc-live-handoff-JdKDeX/evidence.json`。其中 6 条 MCP 语义事件包含 started/completed，不把它们当作 6 次独立工具调用。模型自主发信的结论使用上表独立通信回执，其中记录实际消息、模型回复与 ACK。

生命周期、跨 provider 通信和本轮真实浏览器交互均保留各自执行时的源码摘要，不能把较早回执当作随后修改的全部字节验收。旧生命周期/通信 harness 对 Claude 使用显式外部 SDK 入口；本轮新增的默认加载验收把已安装 SDK 链接到隔离 worker 项目，由生产加载器解析，未注入 query 函数。Codex 本轮回执包括权限重复项修复；Claude 回执早于这一 Codex 权限展示修复，随后共享界面使用完整单元测试和 11 项浏览器检查补验。手机顶部布局的后续调整由最新浏览器回归覆盖。上述证据仍不证明打包分发或员工安装。

验收使用隔离项目、provider home、tmux socket 和浏览器 profile；测试 runtime/进程已关闭，临时凭据副本已移除。原始日志、截图和临时摘要是本机证据，可能被系统清理。协议与诊断脚本不调用模型；live acceptance 脚本仅在明确需要真实调用时执行，会使用调用方额度。

## 尚未实现或未验收

- 任意未托管 TUI/普通终端的活动执行器迁移、私有 daemon endpoint，以及任意协议版本的完整兼容矩阵仍未接入。已托管 tmux 与 HCC native worker 是本次支持路径。
- 任意 MCP 表单字段、URL 身份认证、动态工具、账号 token 刷新等扩展 server request 尚未接入；未知交互保持拒绝或明确报不支持。
- Codex 提问/权限、Claude Write 和 dsh ACP Write 均有真实模型触发、Web 明确应答、拒绝与原 session 本地续接证据；实际覆盖以各回执的源码与 provider 基线为准。真实命令审批拒绝和空表单 MCP 工具批准仍保留独立 provider 证据。
- 默认 Claude SDK 的 worker 项目加载路径已有真实调用验收；发布包和员工设备安装尚未验收，SDK 仍为需要手动安装的可选依赖。
- 本次为本地工作区实现与验证，没有执行提交、推送、发布或部署；线上与真实业务任务验收没有本轮证据。

操作方法见 [Web 继续本地任务](../web-handoff.zh-CN.md)、[MCP 协作工具](../mcp.zh-CN.md) 和 [Native 后台 worker](../native.zh-CN.md)。
