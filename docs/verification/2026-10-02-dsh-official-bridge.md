# DeepSeek Harness 官方桥接验证

> 本文保留阶段一 hooks 的历史隔离验收范围。阶段二 ACP、阶段三 Cordis、真实模型和最终混合工作区结果见 [后续验收记录](2026-10-02-dsh-cordis-native.md)。

日期：2026-10-02。官方运行时与桥接插件版本均固定为 `0.2.0-rc.2`，使用 Node.js `24.19.0`。

可复现脚本：[`scripts/dsh-official-acceptance.mjs`](../../scripts/dsh-official-acceptance.mjs)。此脚本是独立集成验收入口，不增加 hello-cc 的依赖，也不随普通单元测试自动下载包。

## 验证方法

在仓库外创建临时 npm 项目，安装官方发布包并禁用安装脚本：

```sh
DSH_TEST_DIR=$(mktemp -d)
(
  cd "$DSH_TEST_DIR"
  npm init -y
  npm install --ignore-scripts --no-audit --no-fund --save-exact @deepseek-ai/dsh@0.2.0-rc.2
)
node scripts/dsh-official-acceptance.mjs "$DSH_TEST_DIR"
node scripts/dsh-web-startup-acceptance.mjs "$DSH_TEST_DIR"
```

需要 Node.js 24 或更高版本。整个验收使用隔离的临时 HOME、DSH_HOME 与两个含空格路径的项目目录；不读取真实凭据、不调用模型或外部 API。每次运行输出 JSON receipt，并在其 `sandbox` 目录保存 `receipt.json`、实际项目数据库和官方 CLI 生成的 `effective-config.yml`。

实际参与的官方模块包括 Cordis Context、SessionStore、SessionProjectionRegistry、AgentLoop 的 turnBoundary projection、Claude hooks bridge、LocalBashExecutor 和 LocalSubprocessRuntime。官方桥接通过真实 shell 子进程调用当前仓库的 hcc，解析 stdout，并记录官方 Session 日志。Agent 的 `inject` / `steer` 接收端使用内存测试替身；该结果证明桥接接口和协作总线工作，尚未证明真实模型读取上下文并执行任务。

## 本轮结果

可复现脚本通过 **14 项集成断言**：

| 场景 | 结果与证据 |
| --- | --- |
| 项目局部配置 | 当前实现生成 hooks.json 与官方 Cordis overlay，命令携带显式 `--provider dsh` |
| 首轮上下文 | 官方 `agent/created` 等待 SessionStart 完成，返回前接收任务、peers 和锁信息 |
| 会话身份与污染环境 | 同进程两个非 UUID ID 分别写入 `provider_session_id`，不被继承的 Claude/Codex/HCC_PEER 改写 |
| 多工作区 | 同一个官方桥接实例按每次 payload cwd 写入各自数据库，另一个项目看不到第一个项目的任务 |
| 恢复 | 相同真实 session ID 的 resume hook 仍映射原 peer，无额外绑定 |
| 会话命令前缀 | 官方 shell 实际执行两个会话各自注入的 hcc 命令前缀；即使当前 cwd、HCC_ROOT/HCC_DB/HCC_PEER 与 Claude/Codex markers 被污染，消息仍写入正确 sender 与项目数据库 |
| 提示与消息 | UserPromptSubmit 返回 `enter`，保留 downstream metadata，附加解析后的 inbox 上下文并 ACK |
| 双向协作消息 | Claude peer 发给 dsh，dsh peer 的 CLI 回复可在 Claude inbox 查询 |
| 真实锁冲突 | Claude 持有资源时，dsh 第二次 acquire 返回冲突并失败 |
| dsh 工具命名 | 官方 lowercase `bash` 与 `str_replace_editor` 触发 PreToolUse/PostToolUse |
| Stop 续轮 | 官方桥将 `decision:block` 转为 `steer`；同一已确认消息不重复续轮 |
| 官方日志 | 5 条 hook/result 全部记录 `exitCode: 0` |
| 配置组合 | 官方 dsh CLI 的 `web --patch ... --dump-config` 成功加载生成的 overlay |
| 公开启动器 | `hcc dsh web --dsh-bin ... -- --help` 启动官方 Web app 并正确转发帮助参数，没有登记服务级 peer |

另外，[`test/dsh-runtime-boundary.test.mjs`](../../test/dsh-runtime-boundary.test.mjs) 的 **2 项单元测试**证明：两个 dsh hook peers 即使共享服务 PID 和 tmux pane，也不会自动 attach 或改写会话身份；原有 Claude hook 和 Codex detected peers 仍能自动 attach。现有 tmux reconcile SQL 只处理 `transport=tmux`，不会 backfill dsh hook peers。

[`test/dsh-tmux-attach-boundary.test.mjs`](../../test/dsh-tmux-attach-boundary.test.mjs)
另有 **9 项行为测试**，使用真实 SQLite 与隔离 tmux CLI 替身，证明手动/force
attach 不覆盖 dsh hook 绑定、拒绝服务被推断为单个 dsh Agent、事务中复检并发
注册，以及原有 Claude/Codex 和独立 shell 日志面板仍正常。
[`test/dsh-web-boundary.test.mjs`](../../test/dsh-web-boundary.test.mjs) 的 **4 项 HTTP
测试**验证独立会话/消息、拒绝 stop/restart/attach、原记录保留与核心拒绝映射为 409。

## 官方 Web 服务真实启动

[`scripts/dsh-web-startup-acceptance.mjs`](../../scripts/dsh-web-startup-acceptance.mjs) 通过公开 `hcc dsh web` 命令启动同版本官方 Web 服务，使用隔离 HOME/DSH_HOME、回环监听地址、临时空闲端口与 `--no-open`。验收禁用 dsh telemetry，不传入模型凭据，不创建 Agent 或模型任务；仅访问其登录、页面和观察到的静态资源。

真实启动验证通过：匿名 GET `/` 返回 **401**；该隔离服务自己签发的 launch token 换取 **303** 与 cookie；带 cookie 的页面返回 **200**，标题为 `DeepSeek Harness`，包含 `__DSH_BOOT__`，HTML 为 **34,782 字节**。页面引用的插件 bootstrap 和主 JavaScript 分别返回 **200**，大小为 **40,330** 与 **633,282 字节**。服务继续运行，stderr 为空；随后只停止脚本拥有的 wrapper/service，正常退出并确认监听端口已关闭。

该脚本保存独立 JSON receipt、stdout/stderr 与页面 HTML。临时服务的登录 token 只存在于它自己的隔离日志中，验收结果不输出 token。原生 terminal addon、模型请求和浏览器实际渲染没有包含在这项 HTTP 启动验收中。

## hello-cc 浏览器验收

使用 Codex 内置浏览器与统一电脑控制接口，窗口为 **1280×720**。测试地址为
`http://127.0.0.1:55634`，只连接隔离项目与临时 HOME。流程为：打开控制台 →
选择 dsh 筛选 → 查看第一个 hook peer → 发送消息 → 查看第二个 peer →
切换界面语言。测试 runtime 和浏览器页签已关闭，监听端口已确认关闭。
两个 peers 由隔离测试 payload 经真实 hcc hook CLI 登记；它们用于验证控制台
行为，不代表真实模型对话或用户设备验收。

| 检查 | 结果 |
| --- | --- |
| 页面身份、非空内容 | URL、hello-cc 标题和实际项目内容正确 |
| 框架错误层、console | 没有错误层；error/warn 均为 0 |
| 筛选、会话详情 | 两个独立 dsh peers；原始非 UUID provider session ID 可见 |
| 控制能力 | dsh hook peer 没有停止、重启或终端工具栏；显示原生 Web 操作说明 |
| 实际消息操作 | 第一个 peer 的 inbox/timeline 显示消息；第二个无该消息；SQLite 收件人核对一致 |
| 中英文 | 能切换能力说明与界面文案；结束后恢复原先 system 语言设置 |
| 截图 | 已保留中文详情、正确收件人消息与 dsh 筛选的截图 |

未验证移动端、其他浏览器、dsh 原生 Web 的完整对话与真实模型工具行为。

## 验收边界

官方 `0.2.0-rc.2` 的 SessionStart 使用 awaited `agent/created`；旧 `0.0.1-rc.5` 包使用 detached `agent/session-start`，不能用旧包的行为作为此版本证据。此桥的 Stop payload 固定 `stop_hook_active:false`；当前按消息 ACK 防止相同消息重复续轮，但持续到达的新消息仍可能触发新的续轮。

实际 shell 的 hcc 会话身份与协作写入已经验证。模型是否正确选用注入的命令、理解上下文并完成任务、dsh 原生 Web 端完整对话、真实机器安装与协同业务效果，仍需后续真实模型与交互验收。SDK / ACP 控制不属于本轮第一阶段实现。
