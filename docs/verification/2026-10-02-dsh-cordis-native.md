# DeepSeek Harness Cordis / native 验收记录

日期：2026-10-02。目标：`/Users/xf02163/Desktop/project/wjj/hello-cc` 当前混合工作区；Node.js `v24.19.0`；官方 Harness 及 agent/agent-loop/tools/session 模块 `0.2.0-rc.2`。

阶段二 ACP 与阶段三 Cordis 的源码和本地运行验证已完成，并已执行真实 DeepSeek 模型请求。此前 hooks 的独立记录见 [官方桥接验收](2026-10-02-dsh-official-bridge.md)；该文档中的旧隔离副本数量仅代表当时阶段一。

## 验收矩阵

| 验证层 | 结果 | 能证明的范围 |
| --- | --- | --- |
| 当前工作区单元测试 | 819 项；818 通过、1 跳过、0 失败 | 本地 CLI、provider、native、MCP、Web 和协作边界；跳过项为 macOS 不适用的 Linux proc 伪文件检查 |
| factory 标识符审计 | 63 个模块通过，无 free identifiers | 注册的 factory 模块静态依赖完整性 |
| 完整 regression | 13 步通过，`FULL_REGRESSION_OK` | 本地协调、消息、锁、多项目、Web/tmux、恢复、身份和维护流程 |
| Cordis 定向单元 | 9/9 通过 | mode 幂等、归属/项目隔离、取消/截断、决定链、提交 ACK、重载和版本门禁 |
| hooks 官方运行时 | 14 项隔离断言通过 | 阶段一真实 Cordis/Session/Bash/CLI hooks；Agent 接收端有内存替身，非真实模型验收 |
| native ACP 真实模型 | 4 项通过，4 次 prompt | 真实投递与相关回执、跨轮记忆、close/resume、活动轮中断 |
| Cordis 真实模型 | 6 项通过；1 次真实 permission request 被拒绝 | 同服务两个 Agent、双项目、协作业务写入、deny/ask、提交 ACK、关闭隔离与恢复 |
| 安装后的公共 CLI / 官方 plugin 管理 / 真实任务 | 11/11 通过；真实 ACP 写审批被拒绝 | 新 npm prefix 安装、Node 24 PTY、官方 add/重复 add/remove、默认 PATH native adapter、证据与任务完成闭环；macOS arm64 |
| 本地 tarball / 隔离 profile | 7 项通过，10 次本地 Messages 请求 | 发布包结构、官方 profile 解析、真实 Harness 工具/权限/持久化；模型为本地确定性端点 |
| UI 文案收尾定向测试 | 28/28 通过 | Cordis、Web 边界、会话详情与偏好设置 |
| 官方 Cordis Web 启动 | 通过 | 401→token 登录 303→页面/资源 200；无服务级 peer；退出后端口关闭 |
| hello-cc Cordis 浏览器 | 7 项通过；1440×900 与 390×844 | 筛选、真实 ID、控制边界、定向消息、响应布局、console/资源健康 |

所有官方运行时验收均使用临时 HOME/DSH_HOME/项目和自有进程。真实模型沿用调用者既有认证及 provider 路由，不在文档或日志输出密钥。

## Cordis 实际协作与权限

官方 AgentLoop 通过实际模型工具轮次执行 `hcc_state`、任务认领、作用域锁、peer 消息及任务交接；验收直接读取对应 SQLite 记录检查任务 owner、锁 owner/task、消息 recipient 与交接内容。锁检查覆盖实际 `resource` 与 `base_resource`，不假设模型一定选择默认锁作用域。

同一 Harness 服务中两个 Agent 分属不同工作区，分别持有原始 session ID 和稳定 peer。A 的提交只 ACK A 的收件箱；B 的项目与收件箱不变。关闭 A 只使 A 的 peer 退出，B 继续真实 prompt；恢复 A 保持原始 session 和 peer，不产生重复 live owner。

Harness 的 deny 规则拒绝一次指定文件写入；ask 规则触发一次实际 ACP permission request，客户端选择拒绝，目标文件均不存在。此项是 Cordis 官方运行时和真实模型的证明，不能表述为 native live 脚本也触发了权限请求。

本地 Messages 模型额外检查首个请求确实已包含等待式 hello-cc 上下文，不含另一个 Agent 的上下文。真实远端模型验收依赖其真实工具行为、数据库结果与官方 session 持久化，未拦截远端请求正文，因此共 6 项而非本地模式的 7 项。

## Native 实际生命周期

`native-live-acceptance.mjs` 调用与产品相同的 native service、dsh ACP adapter 和 HCC 总线，使用隔离环境 factory：

1. 真实 prompt 完成，消息投递得到对应 turn 的 reply 与 ACK；重复入队保持幂等。
2. 下一轮真实模型保留前一轮 nonce，证明会话记忆可用。
3. 关闭自有 worker 后 resume，provider session ID 与原有记忆保留。
4. 活动轮中断后留下失败终态；不生成成功回复或 ACK。

最终收尾按当前 dsh adapter 再跑 4 项真实模型验收；运行期间源码没有变化，回执中的 dsh adapter、JSON-RPC 与 native runtime/service/store 共 5 个文件 SHA256 与当前文件一致。

生命周期脚本仍使用隔离 factory；本次追加的安装验收通过全新 npm prefix 的公共 CLI 验证默认 PATH 和真实 dsh adapter，未注入 adapter factory。`native-live-acceptance.mjs` 本身没有执行 dsh 权限探针，回执现在按实际 provider 标明该项未执行；真实 dsh 拒绝验证由 `dsh-installed-acceptance.mjs` 完成。未接管已有 TUI/Desktop，也未修改用户全局安装。ACP 恢复不回放整个 transcript，当前不提供 fork/steer。

## 包装与版本

Cordis 运行时从真实 dsh launcher 解析 agent/agent-loop/tools/session 包，严格要求 rc.2；类型和工具定义遵循该版本的实际契约。配置 metadata 同时声明 `engines.dsh` 和 `dsh.bundle`。

隔离包装验收通过 `npm pack --ignore-scripts` 生成 `logicseek-hello-cc-1.0.1.tgz`，共 224 个文件，SHA1 shasum 为 `b966c24dde6c247ef331cf6e7785532bc1d0eda2`。脚本检查 bundle/type 文件存在，并将包内容放入临时 ACP profile 的 node_modules，通过官方 profile bundle 机制启动和执行工具。

该验证证明包内容及 profile 加载，未执行用户真实 profile 的包管理安装/移除。文档继续收尾后增加了本验收文件并修正 UI 提示，因此此 shasum 仅对应验收时的 tarball；交付最新包需重新 pack。运行时代码四个核心文件与真实模型和 bundle 回执的 hashes 一致；真实模型回执里的验收脚本随后只扩展了 `--bundle` 分支，bundle 回执匹配现有脚本。

## 安装后验收与任务闭环

新增 `scripts/dsh-installed-acceptance.mjs` 使用实际 npm 安装和官方插件包管理，11 项检查全部通过：

1. 将候选 tarball 安装到新的私有 npm prefix，安装后的 Node 24 实际加载并运行 PTY。
2. 安装包中 12 个 CLI、Cordis、ACP、JSON-RPC、native service/client 和 MCP 文件的 SHA256 与当前源文件相同，运行期间无漂移。
3. 安装后的 `hcc dsh setup --mode cordis`、重复 setup 和 status 保持幂等，PATH 指向固定官方 launcher。
4. 官方 `plugin add`、重复 add 和 remove 成功；bundle 只注册一次，`cordis.patch.yml` 在包管理前后原样保留，移除后基础 profile 仍可启动。
5. 安装后的 Cordis bundle 实际调用真实模型执行 `hcc_state` 和发信，创建/关闭真实 Agent。
6. 通过公共 `hcc native up/start --provider dsh` 启动 worker，没有二进制覆盖参数或 adapter factory 替身。
7. 在私有 profile 对一个测试文件配置 ask，真实模型尝试写入；收到实际 `session/request_permission` 并从关联工具输入确认路径，公共 CLI 拒绝后文件未生成。
8. 真实 worker 认领订单汇总任务、加锁、读取三条订单并生成报告。独立验证数量 6、金额 66，SKU A 为 4/50、B 为 2/16。
9. 数据库核对发信、结果证据、交接和解锁；独立核对报告后通过 worker 的 HCC CLI 完成任务，状态为 `done`。
10. 公共 close 只退休该 worker；Cordis/native runtime 停止，临时 provider state 删除。

实际安装发现 Harness pnpm 默认拦截原生构建。验收仅在私有 profile 的 `pnpm-workspace.yaml` 中允许固定的 `node-pty@1.2.0-beta.15`；中英文指南已补充步骤，没有开启所有依赖构建。官方生成的 `cordis.yml` 与用户扩展 `cordis.patch.yml` 已区分；测试策略写入后者。

真实 rc.2 的审批请求只携带工具 ID，工具参数通过另一个 `session/update` 发布。本次修复 dsh adapter：关联当前 session/turn 的工具输入，处理两种到达顺序，缓存有界并在结束/中断/退出清理；等待超过 1 秒仍缺输入或输入过大时只允许拒绝。新增 5 项测试覆盖时序、外部会话、取消、缺失与截断；native adapter/runtime/CLI 定向测试 37/37 通过，随后真实拒绝和四项生命周期验收均通过。

长期交付目录是 `/Users/xf02163/Documents/Codex/artifacts/dsh-integration-2026-10-02`。候选包 SHA256、文件数和完整安装回执保存在该目录的 `dsh-installed-receipt.json`；每次 pack 后重跑安装验收，不能沿用上方历史 224 文件包的摘要。订单报告和脱敏日志同目录留存。该样例是隔离任务流程验证，不等于真实业务签收。平台为 macOS arm64，未外推 Windows/Linux 安装结果。

## 浏览器检查

Browser availability：**Absent**；回退原因：`Browser plugin not available`。使用现有 Playwright 和已安装 Chromium `149.0.7827.55`，未安装新浏览器依赖。

目标路径：hello-cc 页面 → dsh 筛选 → Cordis 检测会话 A → 原始 session 详情 → 发送消息 → SQLite 收件人验证 → 手机视口。

| 检查 | 结果 |
| --- | --- |
| 页面身份、非空内容、框架错误遮罩 | 通过 |
| dsh 筛选与会话边界 | 2 个独立 Cordis peers；无 detected stop/restart |
| 原始 ID 和帮助 | 显示 `session.cordis/QA-A`；在 Harness 原生界面控制会话 |
| 中英文消息提示 | 设置切换后均显示下一次 Harness 步骤与空闲行为 |
| 消息交互 | 发送后输入框清空；仅 A 收到一条 `web` 消息，B 收件箱为空 |
| 响应布局 | 桌面 1440×900 和手机 390×844；详情与发送可见，面板不溢出 |
| 页面/console/资源 | 页面错误、console error/warn、失败资源请求均为 0 |

该轮视觉检查发现 Cordis 发送提示沿用了“下一次 hook”，随后修正中英文文案为“下一次 Harness 步骤”，并重跑同一交互流程。原官方 hooks 提示保留其自身语义。此次浏览器操作没有调用模型，模型工具与会话控制的验证见上文。

截图保存在仓库外：

- `/Users/xf02163/.codex/visualizations/2026/10/02/01a0fbbc-cce3-75a0-a910-c1f2a6c92c7d/dsh-cordis-web-desktop.png`
- `/Users/xf02163/.codex/visualizations/2026/10/02/01a0fbbc-cce3-75a0-a910-c1f2a6c92c7d/dsh-cordis-web-mobile.png`

浏览器只覆盖 Chromium 和以上两个尺寸；其他浏览器、员工设备及真实业务工作流不在此记录内。

## 原始证据

| 证据 | 本机路径 |
| --- | --- |
| 最新单元 / audit / regression | `/tmp/hello-cc-dsh-delivery-unit.log`、`/tmp/hello-cc-dsh-delivery-audit.log`、`/tmp/hello-cc-dsh-delivery-regression.log` |
| 安装后 11 项回执、候选包与订单报告 | `/Users/xf02163/Documents/Codex/artifacts/dsh-integration-2026-10-02/dsh-installed-receipt.json`、同目录候选 tgz 与 `order-summary.json` |
| 审批修复定向测试 | `/tmp/hello-cc-dsh-approval-unit.log` |
| native 真实模型回执 / 日志 | `/tmp/hello-cc-dsh-native-live-receipt.json`、`/tmp/hello-cc-dsh-native-live.log` |
| Cordis 真实模型日志 | `/tmp/hello-cc-dsh-cordis-live-final.log` |
| Cordis 真实模型回执 | `/private/var/folders/w2/xwv9k9950t7d3v8t_h2l0gjc0000gn/T/hcc-dsh-cordis-acceptance-mFUwPe/receipt.json` |
| tarball/profile 日志 | `/tmp/hello-cc-dsh-bundle-official.log` |
| tarball/profile 回执 | `/private/var/folders/w2/xwv9k9950t7d3v8t_h2l0gjc0000gn/T/hcc-dsh-cordis-acceptance-aYcjMR/receipt.json` |
| 官方 Cordis Web | `/tmp/hello-cc-dsh-cordis-web.log` |
| UI 收尾定向测试 | `/tmp/hello-cc-dsh-ui-final-scoped.log` |
| 最新浏览器回执 / 日志 | `/tmp/hello-cc-dsh-cordis-ui-receipt.json`、`/tmp/hello-cc-dsh-cordis-ui.log` |

native 回执记录来源文件 SHA256 及运行期间无源码漂移；Cordis 回执记录核心文件 SHA256、Node/官方版本、模型类型、断言与清理结果。临时目录与 `/tmp` 并非长期交付存储，重新验证时应保存新回执。

## 复现命令

先准备包含 `@deepseek-ai/dsh@0.2.0-rc.2` 的独立安装目录；脚本不会安装官方包。以下 `DSH_INSTALL` 为该目录，不是 launcher 文件。

```bash
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
DSH_INSTALL='/absolute/path/to/isolated-dsh-install'
cd /absolute/path/to/hello-cc
npm run test:unit
npm run test:audit
npm run test:regression

# 官方运行时，默认仅使用本地确定性 Messages 模型
node scripts/dsh-cordis-acceptance.mjs "$DSH_INSTALL"
node scripts/dsh-cordis-acceptance.mjs "$DSH_INSTALL" --bundle

# 沿用调用者已有 DEEPSEEK_API_KEY / provider 路由，真实模型调用
node scripts/dsh-cordis-acceptance.mjs "$DSH_INSTALL" --run-live
node scripts/native-live-acceptance.mjs --run-live --provider dsh \
  --dsh-bin "$DSH_INSTALL/node_modules/@deepseek-ai/dsh/lib/bin.js"

# 实际 npm/plugin 安装和公共 CLI；--run-live 执行真实拒绝与订单任务
node scripts/dsh-installed-acceptance.mjs "$DSH_INSTALL" --run-live \
  --output-dir /absolute/path/to/persistent-acceptance-output

# 不调用模型，验证官方 Web 与项目 Cordis overlay
node scripts/dsh-web-startup-acceptance.mjs "$DSH_INSTALL" cordis
```

本次独立官方安装为 `/var/folders/w2/xwv9k9950t7d3v8t_h2l0gjc0000gn/T/hcc-dsh-official-acceptance-m0n74ee2`。首次 setup 默认 hooks，Cordis 使用 `hcc dsh setup --mode cordis`；禁用使用 `--mode off`。profile 级安装的公开命令是 `dsh plugin --profile web add /absolute/path/to/tarball`，不能写成 `install <package>`；它转发包管理参数。项目 overlay 与 profile bundle 不同时启用。

## 清理和交付范围

native runtime 已停止并移除临时 provider 凭据。Cordis runtime、本地模型端点及 Web 均已停止；Web 端口关闭，浏览器 fixtures 的两个自有 peer 已 dispose。没有删除用户现有服务、会话或并行开发的工作区改动。

本记录覆盖本地源码、官方隔离运行时、真实认证模型、实际 npm/profile 包管理安装与安装后公共 CLI、代表性订单任务闭环。此处记录隔离验收；后续已新增实际 Mac desktop profile 热加载和实际 ACP 验收，见 [本机接入记录](2026-10-02-dsh-device-install.md)。npm 发布、推送、部署、其他设备安装和真实业务签收仍未完成。使用指南：[中文](../dsh.zh-CN.md) / [English](../dsh.md)；详细计划：[接入计划与完成记录](../plans/2026-10-02-dsh-integration.md)。

追加本机接入之后，混合工作区再次运行全套测试：867 项，866 通过、1 项 macOS 平台跳过；63 个 factory 审计、13 步回归通过。该数字包含并行开发的其他模块；冻结 1.0.2-dsh.1 候选另有 8/8 安装检查、本机实际 ACP 恢复记忆与桌面 DeepSeek 工具回合证据。
