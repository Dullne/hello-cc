# DeepSeek Harness 接入

[English](dsh.md) | 中文

DeepSeek Harness（`dsh`）可以与 Claude Code、Codex 共用 hello-cc 的项目任务、消息、协作锁和交接。现在有三个入口：官方 hooks 兼容桥、原生 Cordis 协作插件，以及 hello-cc 持有的 ACP 后台 worker。

运行时基线固定为 `@deepseek-ai/dsh@0.2.0-rc.2`，相关插件使用相同版本。需要 Node.js 24+，并确认 `PATH` 中的 `node` 也符合要求，因为 dsh 通过 `/usr/bin/env node` 启动。此版本提供 Web/headless/SDK/ACP profile，没有内置 TUI。

支持 Linux 和 macOS；Windows 使用 WSL，不支持原生 Windows shell。容器验证与实际设备验收分别记录。

代码已在本地实现并做真实 DeepSeek 模型验收，尚未发布新的 npm 版本。验证源码时，用本仓库的 CLI：

```bash
node /absolute/path/to/hello-cc/bin/hcc.mjs --root /path/to/project dsh setup --mode cordis
node /absolute/path/to/hello-cc/bin/hcc.mjs --root /path/to/project dsh status
node /absolute/path/to/hello-cc/bin/hcc.mjs --root /path/to/project dsh web -- --port 8080
```

下文 `hcc` 指包含这些代码的 CLI。已有的全局 `hcc` 未必包含此接入。

## 选择入口

| 入口 | 适用场景 | 会话由谁持有 |
| --- | --- | --- |
| `hcc dsh web --mode cordis` | 在 Harness Web 中对话，模型直接使用 `hcc_*` 协作工具 | Harness；一个服务可承载多个 Agent/工作区 |
| `hcc dsh web --mode hooks` | 保留官方 Claude hooks 兼容路线，模型用带身份的 hcc CLI 命令协作 | Harness；默认模式 |
| `hcc native start --provider dsh` | 从 hello-cc CLI/Web 管理提示、回执、中断和关闭 | hello-cc 专属 ACP worker；每个 worker 一个独立进程 |

Cordis 模式与 hooks 模式共用同一任务总线，但对同一个会话只允许一个注入器。ACP worker 使用自己的 native 生命周期与 scoped MCP 能力，不给它额外加载 Cordis/hooks 协作注入器。

## Harness Web 与 Cordis 插件

先配置 Harness 模型凭据。默认 DeepSeek provider 使用已有 `DEEPSEEK_API_KEY`，启动器保留凭据和 provider 路由环境变量。可以使用已有安装，或自行安装固定版本：

```bash
npm install -g @deepseek-ai/dsh@0.2.0-rc.2
cd /path/to/project
hcc dsh setup --mode cordis
hcc dsh status
hcc dsh web -- --port 8080
```

打开 Harness 输出的 URL，创建真实会话，并将项目设为会话工作区。仅启动服务不会创建 Agent peer。需要 hello-cc 控制台时另开 `hcc web --local`；dsh 筛选显示原始会话 ID，可以查看状态和发送项目消息。

Cordis 插件使用 `agent/created` 的等待式初始化、`agent/pre-step` 的决定链、`agent/status`/`agent/disposed` 和工具事件。每次执行从 `exec.agent` 获取固定项目与 peer，不读取服务级 `HCC_PEER`。插件提供：

| 工具 | 用途 |
| --- | --- |
| `hcc_state` / `hcc_task_list` / `hcc_inbox` | 读取项目状态、任务和本会话收件箱 |
| `hcc_task_next` | 继续当前任务或认领待办，不自动完成任务 |
| `hcc_message_send` | 以本 Agent 身份发送项目协作消息 |
| `hcc_handoff` | 记录所持任务的交接内容 |
| `hcc_lock_acquire` / `hcc_lock_release` | 获取/释放本 peer 的作用域协作锁 |
| `hcc_result_list` / `hcc_result_record` | 读取/记录本地验证证据，不代表发布或业务验收 |

底层复用 CLI/MCP 的事务、任务归属和锁规则。上下文与工具输出默认各限制 16,000 字符；过长输出明确标记截断，未完整投递的消息保留未读。工具参数的长度、数量和归属由服务再次验证。消息只在 Harness 提交对应 `user/message` 记录后 ACK；拒绝首轮、准备失败和取消不会提前 ACK。

插件委托 `next()`，保留现有 deny/ask 权限决定。关闭 Agent 只更新其自身 peer；卸载时移除监听与工具注册，并使旧的执行权限失效。重新加载时，既有 Agent 在下一个等待式 pre-step 重新取得身份。异常退出后，只有核实原进程已退出或 PID 已被复用时，同一会话才能恢复 Cordis 归属；活跃或无法验证的 owner，以及 hooks/native 冲突绑定仍会被拒绝。发送项目消息本身不会唤醒持续空闲的 Harness 会话；它在下一步骤进入上下文，或在活动轮次的停止边界继续处理。

## 配置模式与参数

```text
hcc dsh setup [--mode hooks|cordis|off]
hcc dsh status [--dsh-bin PATH]
hcc dsh web [--mode hooks|cordis|off] [--dsh-bin PATH] [--dsh-home PATH] -- [dsh arguments]
```

首次默认 `hooks`，以后不带 `--mode` 时沿用托管配置记录的选择。`status` 校验内容与可执行文件，不发模型请求。

```bash
hcc dsh setup --mode hooks    # 官方兼容桥
hcc dsh setup --mode cordis   # 原生协作插件
hcc dsh setup --mode off      # 项目 overlay 不再加入协作插件
hcc dsh web --dsh-bin '/opt/harness/bin/dsh' --dsh-home '/path/to/dsh-home' -- --port 8080 --no-open
hcc dsh web --help            # hello-cc 帮助
hcc dsh web -- --help         # Harness Web 帮助
```

`--dsh-bin` 是文件路径，`--dsh-home` 设置子进程 `DSH_HOME`；相对路径按执行目录解析。所有 Harness 参数放在 `--` 后，按原顺序传递，包括额外 `--patch`。模式变更影响后续启动，关闭当前自有 runtime 后重新启动才会生效。已有 hooks/native 会话不会被强行改绑为 Cordis；切换时使用新会话，保留旧会话的协作数据。

托管文件如下：

| 文件 | 用途 |
| --- | --- |
| `.hello-cc/dsh/hooks.json` | hello-cc 专用 SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/Stop hooks |
| `.hello-cc/dsh/cordis.patch.yml` | 只加载选定注入器；off 为无插件 overlay |
| `.hello-cc/dsh/managed.json` | 模式、归属、路径、基线版本与 SHA256 |

Setup/disable/re-enable 幂等。升级或移动源码后可再次 setup 刷新绝对路径；手工修改、外来内容、符号链接、硬链接或归属冲突会保留原文件并返回错误。定制配置放在独立 overlay。Setup 不安装 dsh，不改用户 home，不复制密钥，不导入整份 Claude/Codex hooks。

每个 Agent 的真实 `session_id` 和绝对 `cwd` 路由到该工作区自己的 `.hello-cc/mesh.db`，不向父目录找项目。原始非 UUID ID 会保留，hash 碰撞、重复会话别名或其他 live transport 归属都会被拒绝。hooks 与 Cordis peer 禁止被 detected stop/restart 或 tmux attach 改成终端；服务日志面板仍可作为独立 shell peer。

hooks 基线 rc.2 会等待 SessionStart 返回后注入首轮，PreToolUse 用于活动跟踪，PostToolUse/Stop 用于消息投递；官方桥不消费 PreToolUse 的 `additionalContext`。这条兼容路线的 ACK 发生在 hook 输出成功后；Cordis 的 ACK 发生在对应上下文记录提交后。

## ACP 后台 worker

```bash
hcc native up
hcc native start --peer dsh-reviewer --provider dsh
hcc native send --peer dsh-reviewer --from coordinator --body '审查当前改动，报告验证结果'
hcc native deliveries --peer dsh-reviewer
hcc native events --peer dsh-reviewer
hcc native interrupt --peer dsh-reviewer
hcc native close --peer dsh-reviewer
hcc native start --peer dsh-reviewer --provider dsh --binary /absolute/path/to/dsh --resume last
```

默认从 PATH 查找官方 `dsh`；不在 PATH 时用 `--binary /absolute/path/to/dsh` 指定 launcher。worker 使用独立 `dsh --profile acp` 进程；send 返回入队回执，只有权威 prompt 完成事件才代表投递完成。恢复保留 provider session 身份和已有会话记忆；ACP 不回放整个 transcript，也不提供 fork/steer。Web 中使用 native 专属会话入口及审批响应，不能用 detected 注册状态操作代替 worker 生命周期。详见 [Native worker](native.zh-CN.md)。

## 可安装 bundle 与验收

包声明 `dsh.bundle`，overlay 位于 `lib/integrations/dsh.bundle.yml`，类型声明位于 `lib/integrations/dsh-cordis.d.ts`。元数据声明 `engines.dsh=0.2.0-rc.2`；插件还实际检查 agent/agent-loop/tools/session 包版本，遇到不匹配会在注册前拒绝启动。

本地项目 overlay 已可用。setup 的 managed manifest 记录 Cordis 模块位置；从源码切换到 npm 安装目录时会校验并迁移未编辑的配置，保留用户编辑过的文件。需要 profile 级安装时，先生成包含最新源码的 tarball，再通过官方包管理入口安装：

```bash
npm pack --ignore-scripts
dsh plugin --profile web add /absolute/path/to/logicseek-hello-cc-1.0.1.tgz
```

Harness 的 pnpm 策略要求明确允许原生依赖构建。若首次 add 返回 `ERR_PNPM_IGNORED_BUILDS`，在所选 profile 的 `pnpm-workspace.yaml` 中合并以下配置，然后重跑同一 add 命令；默认位置是 `~/.dsh/profiles/web/pnpm-workspace.yaml`，自定义 DSH_HOME 时以该目录为准。保留文件中已有设置，只批准候选包使用的固定版本：

```yaml
allowBuilds:
  node-pty@1.2.0-beta.15: true
```

安装后由 Harness profile 的 `dsh.profile.bundles` 选择包；不要再同时加载项目 Cordis/hooks overlay。bundle 已通过实际 npm 安装、官方 add/重复 add/remove、隔离 profile 加载和真实模型工具调用。2026-10-02 已安装到本机真实 desktop profile 并热加载，配套 ACP 使用既有 DeepSeek 路由完成真实工具调用；初次桌面 sub2api 模型返回账户仅允许 Codex 官方客户端的 403；随后桌面默认模型已变为官方 DeepSeek，沿用当时配置的新建会话完成 hcc_state、hcc_message_send 和真实 completed 回合。原 sub2api 路由限制仍存在。npm 尚未发布。profile 插件安装/移除由 Harness 管理，项目 overlay 则使用 `setup --mode off` 关闭。

验证记录见 Cordis/native 验收 (源码目录: `docs/verification/2026-10-02-dsh-cordis-native.md`)、兼容桥记录 (源码目录: `docs/verification/2026-10-02-dsh-official-bridge.md`) 和详细接入计划 (源码目录: `docs/plans/2026-10-02-dsh-integration.md`)。真实模型验收在临时项目和自有进程中完成；既有会话与模型凭据保留；本机实际安装记录见 Mac 接入验收 (源码目录: `docs/verification/2026-10-02-dsh-device-install.md`)。尚未发布/部署，也没有跨设备验收或真实业务签收；隔离订单样例已完成报告、证据、交接、解锁与任务结束验证。

可用下面的安装验收脚本重现 npm 安装、官方 `plugin add` / 重复 add / remove，以及安装后的公共 CLI。`--run-live` 会沿用已有 DeepSeek 认证，验证 ACP 权限拒绝和一个隔离订单汇总任务；没有该参数时不调用真实模型。脚本只使用本次创建的 HOME、DSH_HOME、项目和进程。

```bash
node scripts/dsh-installed-acceptance.mjs /absolute/path/to/isolated-dsh-install \
  --run-live --output-dir /absolute/path/to/acceptance-output
```

输出包含候选 tarball、SHA256 与安装回执、脱敏命令日志和正确的订单报告。权限探针在私有 profile 中为一个测试文件设置 ask 策略，实际收到 ACP 请求后拒绝并检查文件未生成；订单样例证明本地协作闭环，不替代真实业务签收。
