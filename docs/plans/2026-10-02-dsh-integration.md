# DeepSeek Harness 接入计划与完成记录

更新（2026-10-03）：最终候选 1.0.2-dsh.3 已完成 Mac 和 Linux 容器验收，本机 CLI 已更新；桌面新版已重启激活并完成原会话真实模型验收。npm 发布（待账号 2FA）、其他设备及业务签收未完成。最新证据见 [最终验收](../verification/2026-10-03-dsh-preview-final.md)。下文保留各阶段历史记录。
日期：2026-10-02。运行时基线：官方 `@deepseek-ai/dsh@0.2.0-rc.2`，相关 Harness 模块采用相同版本，hello-cc 使用 Node.js 24+。

本计划的三个实现阶段均已完成本地验证；原生 ACP 与 Cordis 协作已经通过真实 DeepSeek 模型调用。源码改动仍在工作区，npm 尚未发布；实际 profile 安装与待激活状态以上方最新记录为准。完整证据、复现命令及验收范围见 [Cordis/native 验收记录](../verification/2026-10-02-dsh-cordis-native.md)。第一阶段的隔离副本记录保留在 [官方 hooks 桥接验收](../verification/2026-10-02-dsh-official-bridge.md)，其中旧的测试数量不代表最终工作区。

## 目标与架构决策

让 Harness 中的真实 Agent 会话与 Claude Code、Codex 共用 hello-cc 的项目任务板、消息、advisory locks、交接和本地结果证据。项目仍使用自己的 `.hello-cc/mesh.db`；不另建任务总线，不复制任务和锁的事务逻辑。

采用三个可分别使用的入口：

| 入口 | 用户操作界面 | 模型与会话持有者 | 协作接入 | 实施状态 |
| --- | --- | --- | --- | --- |
| 官方 hooks 兼容桥 | Harness Web | Harness | 官方 `dsh-hooks-claude-code` 调用 hcc hooks；带固定身份的 CLI 命令 | 已完成；保留为首次 setup 默认模式和兼容路径 |
| 原生 ACP worker | hello-cc CLI/Web native 入口 | hello-cc 持有的独立 `dsh --profile acp` 进程 | native service、投递回执和 scoped MCP | 已复用现有 native 实现并完成 dsh 真实模型验收 |
| Cordis 协作插件 | Harness Web/headless/ACP profile | Harness；单服务可含多个 Agent/工作区 | typed lifecycle、Agent 作用域 `hcc_*` 工具、提交后 ACK | 已完成；推荐用于 Harness 内直接协作 |

控制路径选择 ACP，不再并行实现另一套 SDK 会话控制协议。Harness rc.2 提供 Web/headless/SDK/ACP profile，没有内置 TUI；服务日志 pane 的进程身份不能代表某个 Agent。hooks/Cordis 会话由 Harness 管理，native worker 由 hello-cc 的专属生命周期入口管理。

## 阶段一：官方 hooks 桥接

| 工作项 | 实现与完成标准 | 验证状态 |
| --- | --- | --- |
| 项目配置 | `hcc dsh setup/status/web`；生成 `hooks.json`、`cordis.patch.yml`、`managed.json`；绝对路径与 shell 特殊字符安全 | 幂等、归属、内容 hash、foreign/修改/链接保护通过 |
| 启动器 | 按原顺序转发真实 argv/cwd 与退出状态；保留模型凭据和原 provider 路由 | 官方服务启动、鉴权、脚本资源、退出清理通过 |
| 会话身份 | 完整原始 session ID 导出稳定 peer；原始非 UUID ID 存入 binding；绝对 cwd 选择项目 | 双会话/双项目、身份冲突、hash 碰撞与父环境隔离通过 |
| 上下文 | SessionStart/UserPromptSubmit/工具/Stop 生命周期复用 peers/tasks/messages/locks | 官方真实 hooks、Session/projections、Bash/subprocess 的 14 项隔离断言通过 |
| Web 边界 | dsh 筛选、原始会话详情、消息入口；拒绝 detected stop/restart 与 tmux attach | UI/API、预检与事务复检通过；服务不注册为单个 Agent |

官方桥在 hook 输出成功后 ACK，Harness rc.2 不消费 PreToolUse 的 `additionalContext`。该路径仍按官方事件能力运行；更精确的提交时机由阶段三实现。

## 阶段二：ACP 原生 worker

| 工作项 | 实现与完成标准 | 验证状态 |
| --- | --- | --- |
| adapter | 复用 `lib/integrations/native/dsh-acp.mjs` 与 native runtime；initialize/new/prompt/cancel 与 advertised resume/close | 本地协议、runtime、CLI/Web 控制边界通过 |
| worker 所有权 | 每个 worker 独占一个 ACP 进程；固定项目、peer 和 execution authority | 其他 Agent、检测会话和现有客户端不被接管 |
| 投递语义 | send 返回入队回执；仅权威 prompt 完成才产生成功 reply/ACK | 真实模型相关回执、重复入队幂等验证通过 |
| 会话记忆 | 原有 session 身份与下一轮记忆保留；close/resume 恢复原身份 | 真实模型 nonce 记忆和关闭恢复通过 |
| 中断 | 取消活动 prompt 后留下终态失败证据，不伪造 reply/ACK | 真实模型活动轮中断通过 |
| 审批 | 暴露 provider 权限请求与关联工具输入，保留拒绝决定 | 本地时序/取消/缺失/截断覆盖；安装后公共 CLI 真实拒绝测试文件写入通过 |

本阶段真实模型验收共 4 项、4 次 prompt。ACP 恢复不回放整个 transcript，当前不支持 fork/steer；不将其他现有 TUI/Desktop 会话转为本 worker。真实 Harness 的 deny/ask 验证在阶段三另行完成。

## 阶段三：Cordis 原生协作插件

### 模块与交付

| 模块 | 责任与关键行为 | 实施状态 |
| --- | --- | --- |
| `lib/integrations/dsh-cordis.mjs` | Cordis `apply/inject`、实际 runtime 版本校验、awaited Agent 初始化、决定链与工具注册、插件 dispose | 已完成 |
| `lib/integrations/dsh-collaboration.mjs` | 每 Agent 权限、固定项目/peer、绑定 generation、顺序工具调用、bounded context/output、归属复查 | 已完成 |
| `lib/mcp/tools.mjs` | 导出纯工具目录；Cordis 与 scoped MCP 复用既有协作业务服务 | 已完成；未引入第二套事务 |
| `lib/integrations/dsh-cordis.d.ts` | 配置与 typed snapshot message source 声明；sections 含 `name/text` | 已完成并包含在 tarball |
| `lib/integrations/dsh.bundle.yml`、package metadata | `dsh.bundle`、`engines.dsh` 和安装后的裸包插件路径 | 已完成；隔离 profile 运行通过 |
| setup 与 Web | `--mode hooks\|cordis\|off`，记忆上次模式；Cordis 检测会话详情和消息投递说明 | 已完成；disable/re-enable 和桌面/手机 UI 通过 |

### 运行时契约

1. **身份与项目**：使用真实 Agent 的完整 `session_id` 和绝对 `cwd`。不读取服务级 `HCC_PEER/HCC_ROOT/HCC_DB` 作为 authority，不向父目录自动查找项目。
2. **binding 与恢复**：`provider=dsh`、`transport=cordis`、原始 provider/runtime session ID、唯一 `runtime_target=cordis:<uuid>`。每次读写复查所有者；与 hooks/native/另一个 live Cordis owner 冲突时失败，保留原记录。dispose 只清除自身 generation，保留原始 ID 以安全恢复和检测碰撞。
3. **上下文提交**：`agent/created` 初始化被等待；`agent/pre-step` 委托 `next()` 并保留拒绝决定和 metadata。准备 snapshot 不 ACK；仅匹配真实 session 对象、对应 identified message 的 `session/event → user/message` 提交才 ACK。
4. **边界与截断**：默认上下文和输出各 16,000 字符，可配置 2,048–64,000。截断明确标注，未完整注入的消息保持未读。业务服务再次验证参数、任务归属和锁作用域。
5. **工具**：`hcc_state/task_list/inbox/task_next/message_send/handoff/lock_acquire/lock_release/result_list/result_record` 共 10 个；从 `exec.agent` 取得 authority，调用者不能伪造发送者或跨项目执行。
6. **权限**：`tools/pre-execute` 保留 deny/ask/allow 链；拒绝不改为允许。真实 ACP permission request 可被客户端拒绝，拒绝的文件写入不执行。
7. **卸载与重载**：工具和事件属于 Cordis context，卸载撤销旧 authority、监听与注册，并只标记自有 peer 退出；已有 Agent 在重载后的下一个等待式 pre-step 重新初始化。
8. **唤醒**：项目消息在下一步骤进入上下文，或在活动轮次停止边界继续处理；消息发送不自动唤醒持续空闲的 Harness Agent。

### 配置与兼容策略

首次 setup 默认 hooks；以后不传 mode 保留已选模式。Cordis 与 hooks 只启用一个注入器，off 生成无插件 overlay。原有无 mode 的托管元数据仍按 hashes 校验。已有会话不强行切换 transport，切换采用新会话并保留旧协作记录。

`engines.dsh=0.2.0-rc.2` 只作为元数据；运行时还从真实 launcher 解析 agent/agent-loop/tools/session 包并核验版本，不匹配时在注册前失败。profile 安装包与项目 overlay 二选一，避免重复加载。

hooks/Cordis peers 不允许检测列表的 stop/restart 或 tmux attach 重写 binding；服务日志可使用独立 shell peer。native 控制通过 native API/CLI 完成，native 的 Web 控制与 scoped MCP 回归也已经复核通过。

## 实施顺序与验收门槛

| 顺序 | 工作产物 | 退出门槛 | 最终状态 |
| --- | --- | --- | --- |
| 1 | 官方版本、hooks/ACP/Cordis 契约调查与计划 | 明确真实会话、服务与终端边界 | 完成 |
| 2 | hooks/config/launcher/Web | 归属与身份隔离；官方服务可启动 | 完成 |
| 3 | native ACP 控制接入 | 真实 prompt、记忆、恢复、中断及回执 | 完成 |
| 4 | Cordis authority、事件、工具、类型与 bundle | delegate/deny/ask、commit ACK、输出边界、卸载与恢复 | 完成 |
| 5 | 官方运行时集成 | 同一服务两个 Agent、双项目、本地模型与真实 DeepSeek 协作均通过 | 完成 |
| 6 | 包装与 UI | 临时 tarball/profile 加载、桌面和手机展示/消息隔离 | 完成 |
| 7 | 当前混合工作区回归与文档 | 单元、factory audit、13 步 regression 通过；证据范围明确 | 完成 |
| 8 | 实际候选包安装与代表性任务 | npm 安装、官方 plugin add/重复 add/remove、默认 native CLI、真实权限拒绝、报告/证据/交接/解锁/任务 done | 完成；11/11 验收，macOS arm64 |
| 9 | 本机真实 desktop/ACP 接入 | 热加载、官方 DeepSeek Cordis 工具回合、安装 CLI 与真实 ACP 回执/恢复记忆 | 完成；原 sub2api 路由仍受账户限制 |
| 10 | npm 预览交付 | 冻结 1.0.2-dsh.1 包、dry-run、安装验收 | 准备完成；发布凭据 401，未发布 |

实施时保留其他会话同时开发的 native、Codex App Server、Web 接手等改动；没有用旧隔离副本的结果替代最终混合工作区检查。

最终全套结果为 **819 项测试，818 通过、1 跳过、0 失败**；跳过项为 macOS 不适用的 Linux proc 伪文件检查。**63 个 factory 模块审计通过**，**13 步 regression 输出 `FULL_REGRESSION_OK`**。Cordis 真实模型 6 项、native 真实模型 4 项、隔离 bundle 7 项通过；bundle 使用本地 Messages 模型，不能将其计作远端模型调用。UI 修正文案后重跑相同浏览器流程。追加安装验收 11/11 通过；实际 npm prefix 和官方 profile 使用同一候选包，原生构建只允许固定 node-pty 版本。审批时序修复定向测试 37/37，最新 native 真实模型 4 项再次通过。

## 交付与后续发布边界

本地源码、项目 overlay、官方 bundle 实际安装/移除、安装后公共 CLI、真实模型协作和隔离订单任务闭环已完成。候选包、SHA256 回执及报告保存在 `/Users/xf02163/Documents/Codex/artifacts/dsh-integration-2026-10-02`。使用方法见 [中文指南](../dsh.zh-CN.md) / [English guide](../dsh.md)，命令参考见 [中文命令文档](../commands.zh-CN.md)。

本机实际 desktop profile 已通过官方管理器热加载；新增官方 Desktop 的 dsh 命令链接与安装包专用 hcc-dsh 入口。原有全局 hcc 开发链接、模型凭据、Claude/Codex home 和现有会话保留。实际 ACP 工具、发信、回执与 ACK 已通过，验收 worker 已关闭。初次桌面 sub2api 模型因账户仅接受 Codex 官方客户端返回 403；后续桌面当前默认已变为官方 DeepSeek，新建会话真实协作回合通过。原 sub2api 限制没有被修改。源码切换到安装包的 overlay 路径迁移问题已补实现和 3 项回归测试。详见 [Mac 接入验收](../verification/2026-10-02-dsh-device-install.md)。

npm 最新公开版本为 1.0.1，未含 dsh/native 接入；发布凭据检查返回 401。预览版本使用 1.0.2-dsh.1，发布 dry-run 和隔离安装 8/8 通过；本机安装 CLI 的真实恢复与记忆通过。计划按 dsh 标签发布，保持 latest。发布、其他设备安装与真实业务签收尚未完成。

## 官方依据

- [官方仓库](https://github.com/deepseek-ai/deepseek-harness)
- [CLI profile](https://github.com/deepseek-ai/deepseek-harness/tree/master/apps/cli)
- [Claude hooks 桥](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/hooks/hooks-claude-code)
- [Cordis 插件发布](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish)
- [Agent 生命周期](https://deepseek-harness.github.io/deepseek-harness/reference/agent-lifecycle)
- [ACP 服务](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/acp/acp)

协议与事件结论来自本地隔离安装的官方 rc.2 实际源码、类型声明及运行结果，兼容性不外推到未验证的新版本。
